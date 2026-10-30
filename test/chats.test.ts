import { describe, expect, it } from "vitest";
import { characterImages, chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, plotImages } from "../src/db/schema";
import { excerpt } from "../src/views/chat";
import type { ChatMessage } from "../src/views/context";
import { accountRow, appWith, cast, db, insertCharacter, insertImage, insertPlot, uid } from "./helpers";

const app = () => appWith([accountRow(1), accountRow(2)], [{ token: "me", accountId: 1 }, { token: "other", accountId: 2 }]);

async function insertChat(values: Partial<typeof chats.$inferInsert> = {}) {
  const plot = values.plotId ? null : await insertPlot();
  const [chat] = await db().insert(chats).values({ aid: uid("ct"), accountId: 1, plotId: plot?.id ?? values.plotId!, ...values }).returning();
  return chat;
}

async function message(chatId: number, values: Partial<typeof chatMessages.$inferInsert> = {}) {
  const [row] = await db().insert(chatMessages).values({ aid: uid("ms"), chatId, role: MESSAGE_ROLES.assistant, ...values }).returning();
  return row;
}

describe("excerpt", () => {
  const msg = (text: string) => ({ content: [{ speaker: null, text }] }) as unknown as ChatMessage;
  it("* を落として ASCII の空白を 1 つに畳み、60 文字を超えたら 57 文字 + ... にする", () => {
    expect(excerpt(msg("  *笑う*  こんにちは\n\nまた　ね  "))).toBe("笑う こんにちは また　ね");
    expect(excerpt(msg("あ".repeat(60)))).toBe("あ".repeat(60));
    expect(excerpt(msg("あ".repeat(61)))).toBe(`${"あ".repeat(57)}...`);
  });
});

describe("POST /chats", () => {
  it("自分のチャットだけを新しい順に。アーカイブは別タブ。最後の 1 通の抜粋を付ける", async () => {
    const older = await insertChat({ lastMessageAt: new Date(1000) });
    const newer = await insertChat({ lastMessageAt: new Date(2000) });
    await insertChat({ status: 2 });
    await insertChat({ status: 3 });
    await insertChat({ accountId: 2 });
    await message(newer.id, { content: [{ speaker: null, text: "古い" }] });
    await message(newer.id, { content: [{ speaker: null, text: "新しい" }] });
    await message(newer.id, { content: [{ speaker: null, text: "失敗" }], status: MESSAGE_STATUSES.failed });

    const body = await app().json("/chats", { token: "me" });
    expect(body.chats.map((c: any) => c.aid)).toEqual([newer.aid, older.aid]);
    expect(body.chats[0]).toMatchObject({
      last_message: "新しい", status: "normal", reply_style: "balanced", model_aid: null, persona: null,
    });
    // 章と結末は廃止した
    for (const key of ["chapter", "current_chapter_key", "turns_in_chapter", "finished", "finished_at", "ending_key"]) {
      expect(body.chats[0]).not.toHaveProperty(key);
    }
    expect(body.chats[0].plot).not.toHaveProperty("chapters");
    expect(body.chats[1].last_message).toBeNull();
    expect((await app().json("/chats", { token: "me", body: { tab: "archived" } })).chats).toHaveLength(1);
  });
});

describe("POST /chats のページ送り", () => {
  it("30 件ずつ X-Next-Cursor で続きを引く。最後にメッセージしていないものは後ろに並ぶ", async () => {
    const dated = [];
    for (let i = 0; i < 29; i++) dated.push(await insertChat({ lastMessageAt: new Date(10_000 + i * 1000) }));
    // 同じ時刻のものは id の大きい順
    const tieA = await insertChat({ lastMessageAt: new Date(5000) });
    const tieB = await insertChat({ lastMessageAt: new Date(5000) });
    const blank = await insertChat({ lastMessageAt: null });

    const first = await app().post("/chats", { token: "me" });
    const cursor = first.headers.get("X-Next-Cursor");
    const page1 = ((await first.json()) as any).chats.map((c: any) => c.aid);
    expect(page1).toEqual([...dated.map((c) => c.aid).reverse(), tieB.aid]);
    expect(cursor).toBe(`5000.${tieB.id}`);

    const second = await app().post("/chats", { token: "me", body: { cursor } });
    expect(((await second.json()) as any).chats.map((c: any) => c.aid)).toEqual([tieA.aid, blank.aid]);
    expect(second.headers.get("X-Next-Cursor")).toBeNull();
  });
});

describe("POST /chats/:aid", () => {
  it("他人のチャットは 404", async () => {
    const chat = await insertChat();
    expect((await app().post(`/chats/${chat.aid}`, { token: "other" })).status).toBe(404);
  });

  it("隠したメッセージを除き、場面の状態を遡って埋め、生成中と兄弟を返す", async () => {
    const chat = await insertChat();
    await message(chat.id, { role: MESSAGE_ROLES.user, content: [{ speaker: null, text: "やあ" }] });
    await message(chat.id, { meta: { scene_status: { time: "朝", place: "教室", air: "静か" } } });
    // やり直しの兄弟: first → second → third。表示しているのは third だけ
    const third = await message(chat.id, { meta: { scene_status: { place: "  ", air: "賑やか" } } });
    const second = await message(chat.id, { status: MESSAGE_STATUSES.replaced, replacedById: third.id });
    const first = await message(chat.id, { status: MESSAGE_STATUSES.replaced, replacedById: second.id });
    await message(chat.id, { role: MESSAGE_ROLES.user, status: MESSAGE_STATUSES.hidden });
    const pending = await message(chat.id, { status: MESSAGE_STATUSES.pending });

    const body = await app().json(`/chats/${chat.aid}`, { token: "me" });
    expect(body.messages.map((m: any) => m.status)).toEqual(["normal", "normal", "normal", "pending"]);
    expect(body.chat.scene_status).toEqual({ time: "朝", place: "教室", air: "賑やか" });
    expect(body.pending_message_aid).toBe(pending.aid);
    expect(body.variant_aids).toEqual([first.aid, second.aid, third.aid]);
    expect(body.quota).toEqual({ weekly_usage_percent: 0 });
    expect(body.chat).not.toHaveProperty("scene_images");
  });

  it("メッセージは新しい側の 30 件だけ返し、前があれば older_messages_cursor を付ける。/history で遡る", async () => {
    const chat = await insertChat();
    const rows = [];
    for (let i = 0; i < 65; i++) {
      rows.push(await message(chat.id, { role: i % 2 === 0 ? MESSAGE_ROLES.user : MESSAGE_ROLES.assistant, content: [{ speaker: null, text: `${i}` }] }));
      // 隠したものは数えない
      if (i === 40) await message(chat.id, { status: MESSAGE_STATUSES.replaced });
    }
    const texts = (messages: any[]) => messages.map((m) => m.scene[0].text);
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${from + i}`);

    const body = await app().json(`/chats/${chat.aid}`, { token: "me" });
    expect(texts(body.messages)).toEqual(range(35, 65));
    expect(body.older_messages_cursor).toBe(rows[35].aid);

    const page2 = await app().post(`/chats/${chat.aid}/history`, { token: "me", body: { cursor: body.older_messages_cursor } });
    expect(texts(((await page2.json()) as any).messages)).toEqual(range(5, 35));
    const cursor = page2.headers.get("X-Next-Cursor");
    expect(cursor).toBe(rows[5].aid);

    const page3 = await app().post(`/chats/${chat.aid}/history`, { token: "me", body: { cursor } });
    expect(texts(((await page3.json()) as any).messages)).toEqual(range(0, 5));
    expect(page3.headers.get("X-Next-Cursor")).toBeNull();

    // 他人のチャットと、知らないカーソルは 404
    expect((await app().post(`/chats/${chat.aid}/history`, { token: "other", body: { cursor } })).status).toBe(404);
    expect((await app().post(`/chats/${chat.aid}/history`, { token: "me", body: { cursor: "nope" } })).status).toBe(404);
  });

  it("前のページがなければ older_messages_cursor は null", async () => {
    const chat = await insertChat();
    await message(chat.id);
    expect((await app().json(`/chats/${chat.aid}`, { token: "me" })).older_messages_cursor).toBeNull();
  });

  it("scene_images には説明の付いた絵と、導入で名指しされた絵だけが載る", async () => {
    const labeled = await insertImage();
    const unlabeled = await insertImage();
    const named = await insertImage();
    const character = await insertCharacter();
    const plot = await insertPlot({ openingScene: [{ speaker: null, text: "導入", image: named.aid }] });
    await cast(plot.id, character.id);
    await db().insert(plotImages).values([{ plotId: plot.id, imageId: unlabeled.id }, { plotId: plot.id, imageId: named.id, position: 1 }]);
    await db().insert(characterImages).values({ characterId: character.id, imageId: labeled.id, situation: "笑顔", secret: true });
    const chat = await insertChat({ plotId: plot.id });

    const body = await app().json(`/chats/${chat.aid}`, { token: "me" });
    expect(Object.keys(body.chat.scene_images).sort()).toEqual([labeled.aid, named.aid].sort());
  });
});

describe("POST /chats/:aid/palette", () => {
  it("説明のない絵と伏せた絵は出さない。ただし直近の返答が使っている伏せた絵は残す", async () => {
    const open = await insertImage();
    const secretUsed = await insertImage();
    const secretUnused = await insertImage();
    const character = await insertCharacter();
    const plot = await insertPlot();
    await cast(plot.id, character.id, { speakerKey: "hero" });
    await db().insert(characterImages).values([
      { characterId: character.id, imageId: open.id, situation: "通常", position: 0 },
      { characterId: character.id, imageId: secretUsed.id, situation: "秘密1", secret: true, position: 1 },
      { characterId: character.id, imageId: secretUnused.id, situation: "秘密2", secret: true, position: 2 },
    ]);
    const chat = await insertChat({ plotId: plot.id });
    await message(chat.id, { content: [{ speaker: "hero", text: "やあ", icon: secretUsed.aid }] });

    const body = await app().json(`/chats/${chat.aid}/palette`, { token: "me" });
    expect(body.plot_images).toEqual([]);
    expect(body.characters.hero.map((e: any) => [e.situation, e.secret])).toEqual([["通常", false], ["秘密1", true]]);
  });
});

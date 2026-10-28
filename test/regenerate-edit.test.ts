import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { characterImages, chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, plotImages } from "../src/db/schema";
import { accountRow, cast, ctx, db, fakeMainDb, insertAiModel, insertCharacter, insertImage, insertPlot, settle, uid } from "./helpers";

const app = () => createApp({ mainDb: () => fakeMainDb([accountRow(1), accountRow(2)], [{ token: "me", accountId: 1 }, { token: "other", accountId: 2 }]) });
const request = (method: string, path: string, body: unknown = {}, token = "me") =>
  app().request(`/v1/amis${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }, env, ctx);
const post = (path: string, body?: unknown, token?: string) => request("POST", path, body, token);
const json = async (res: Response | Promise<Response>) => (await (await res).json()) as Record<string, any>;
const drain = async (aid: string) => {
  await (await post(`/messages/${aid}/stream`)).text();
  await settle();
};

async function setup(chapters: unknown[] = []) {
  await insertAiModel({ provider: "mock" });
  const yuki = await insertCharacter({ name: "ユキ" });
  const face = await insertImage();
  const secretFace = await insertImage();
  await db().insert(characterImages).values([
    { characterId: yuki.id, imageId: face.id, situation: "笑顔", position: 0 },
    { characterId: yuki.id, imageId: secretFace.id, situation: "涙", secret: true, position: 1 },
  ]);
  const plot = await insertPlot({ chapters });
  const illustration = await insertImage();
  const secretIllustration = await insertImage();
  await db().insert(plotImages).values([
    { plotId: plot.id, imageId: illustration.id, situation: "教室", position: 0 },
    { plotId: plot.id, imageId: secretIllustration.id, situation: "結末", secret: true, position: 1 },
  ]);
  await cast(plot.id, yuki.id, { speakerKey: "yuki", isLead: true });
  const chatAid = (await json(post("/chats/create", { plot_aid: plot.aid }))).chat.aid as string;
  const [chat] = await db().select().from(chats).where(eq(chats.aid, chatAid));
  const [message] = await db().insert(chatMessages).values({
    aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.assistant, chapterKey: chat.currentChapterKey,
    content: [{ speaker: "yuki", text: "……きみが転校生？" }],
  }).returning();
  return { chat, chatAid, message, face, secretFace, illustration, secretIllustration };
}

const edit = (aid: string, scene: unknown, token?: string) => request("PATCH", `/messages/${aid}`, { scene }, token);

// 本体の test/integration/amis_message_edit_test.rb を移したもの
describe("返答の編集", () => {
  it("本文を書き換えられる。編集した印が付き、レーティングを判定し直す", async () => {
    const { message } = await setup();
    const res = await json(edit(message.aid, [{ speaker: "yuki", text: "……あなたが転校生？" }]));
    expect(res.message.scene.map((l: any) => l.text)).toEqual(["……あなたが転校生？"]);
    const nsfw = await json(edit(message.aid, [{ speaker: null, text: "殺人事件" }]));
    expect(nsfw.message.rating).toBe("nsfw");
    const [row] = await db().select().from(chatMessages).where(eq(chatMessages.id, message.id));
    expect(row.meta.edited_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  });

  it("話者の入れ替えと行の増減ができ、伏せた絵は選べない", async () => {
    const { message, face, illustration, secretFace, secretIllustration } = await setup();
    const res = await json(edit(message.aid, [
      { speaker: null, text: "教室のドアが開いた。", image: illustration.aid },
      { speaker: "yuki", text: "……きみが転校生？", icon: face.aid },
    ]));
    expect(res.message.scene).toEqual([
      { speaker: null, text: "教室のドアが開いた。", image: illustration.aid },
      { speaker: "yuki", text: "……きみが転校生？", icon: face.aid },
    ]);
    expect((await edit(message.aid, [{ speaker: "yuki", text: "……。", icon: secretFace.aid }])).status).toBe(422);
    expect((await edit(message.aid, [{ speaker: null, text: "夜。", image: secretIllustration.aid }])).status).toBe(422);
  });

  it("AI が伏せた絵を使った返答は、その絵ごと編集して保存できる。使われていない伏せた絵は足せない", async () => {
    const { message, secretFace, secretIllustration } = await setup();
    await db().update(chatMessages).set({ content: [{ speaker: "yuki", text: "……", icon: secretFace.aid }] }).where(eq(chatMessages.id, message.id));
    expect((await edit(message.aid, [{ speaker: "yuki", text: "……あなた？", icon: secretFace.aid }])).status).toBe(200);
    expect((await edit(message.aid, [{ speaker: null, text: "夜。", image: secretIllustration.aid }])).status).toBe(422);
  });

  it("出演していない話者は名前のまま残し顔は落とす。地の文の顔とキャラ行の挿絵も落とし、挿絵は 1 枚まで", async () => {
    const { message, face, illustration } = await setup();
    const res = await json(edit(message.aid, [
      { speaker: "通りすがりの男", text: "誰だおまえ。", icon: face.aid },
      { speaker: null, text: "静かだ。", icon: face.aid, image: illustration.aid },
      { speaker: "yuki", text: "……。", image: illustration.aid },
      { speaker: null, text: "誰も居ない。", image: illustration.aid },
    ]));
    expect(res.message.scene).toEqual([
      { speaker: "通りすがりの男", text: "誰だおまえ。" },
      { speaker: null, text: "静かだ。", image: illustration.aid },
      { speaker: "yuki", text: "……。" },
      { speaker: null, text: "誰も居ない。" },
    ]);
  });

  it("空の本文、長すぎる行と話者名は弾く", async () => {
    const { message } = await setup();
    for (const scene of [[], [{ speaker: null, text: "  " }], [{ speaker: null, text: "あ".repeat(1001) }], [{ speaker: "あ".repeat(31), text: "誰？" }], "壊れた"]) {
      expect((await edit(message.aid, scene)).status).toBe(422);
    }
  });

  it("直近の返答以外、ユーザーの発言、生成中のチャット、他人のメッセージは編集できない", async () => {
    const { chat, message } = await setup();
    const [user] = await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.user, content: [{ speaker: null, text: "やあ" }] }).returning();
    expect((await edit(user.aid, [{ speaker: null, text: "書き換え" }])).status).toBe(422);
    const [newest] = await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.assistant, content: [{ speaker: null, text: "なに" }] }).returning();
    expect((await edit(message.aid, [{ speaker: null, text: "書き換え" }])).status).toBe(422);
    expect((await edit(newest.aid, [{ speaker: null, text: "書き換え" }], "other")).status).toBe(404);
    await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.assistant, status: MESSAGE_STATUSES.pending, content: [] });
    expect((await edit(newest.aid, [{ speaker: null, text: "書き換え" }])).status).toBe(422);
  });

  it("場面の状態も一緒に直せる。空にした項目は落とす", async () => {
    const { message } = await setup();
    await request("PATCH", `/messages/${message.aid}`, { scene: [{ speaker: null, text: "夜" }], scene_status: { time: " 夜 ", place: "", air: "あ".repeat(70) } });
    const [row] = await db().select().from(chatMessages).where(eq(chatMessages.id, message.id));
    expect(row.meta.scene_status).toEqual({ time: "夜", air: "あ".repeat(60) });
  });
});

describe("やり直しと選び直し", () => {
  it("やり直すと兄弟ができ、採用されたほうが表示される。選び直すと元に戻せる", async () => {
    const { chatAid, message } = await setup();
    const regenerated = await json(post(`/messages/${message.aid}/regenerate`, { instruction: "もっと短く" }));
    expect(regenerated).toMatchObject({ status: "success", queue_position: 0 });
    await drain(regenerated.message_aid);

    const shown = await json(post(`/chats/${chatAid}`));
    expect(shown.variant_aids).toEqual([message.aid, regenerated.message_aid]);
    expect(shown.messages.at(-1).aid).toBe(regenerated.message_aid);
    const [newMessage] = await db().select().from(chatMessages).where(eq(chatMessages.aid, regenerated.message_aid));
    expect(newMessage.meta).toMatchObject({ regenerate_of: message.aid, instruction: "もっと短く", auto: false });

    const selected = await json(post(`/messages/${message.aid}/select`));
    expect(selected.message.status).toBe("normal");
    expect(selected.variant_aids).toEqual([message.aid, regenerated.message_aid]);
    expect((await json(post(`/chats/${chatAid}`))).messages.at(-1).aid).toBe(message.aid);
  });

  it("直近の返答以外はやり直せず、指示は 200 文字まで", async () => {
    const { chat, message } = await setup();
    expect((await post(`/messages/${message.aid}/regenerate`, { instruction: "あ".repeat(201) })).status).toBe(422);
    await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.assistant, content: [{ speaker: null, text: "後" }] });
    expect((await post(`/messages/${message.aid}/regenerate`)).status).toBe(422);
  });
});

describe("チャットの設定と削除", () => {
  it("渡したキーだけを変える。アーカイブを解くと完結済みなら finished に戻る", async () => {
    const { chatAid } = await setup();
    const res = await json(request("PATCH", `/chats/${chatAid}`, { title: " 新しい題 ", reply_style: "narration", choice_mode: "1" }));
    expect(res.chat).toMatchObject({ title: "新しい題", display_title: "新しい題", reply_style: "narration", choice_mode: true });
    expect((await request("PATCH", `/chats/${chatAid}`, { reply_style: "nope" })).status).toBe(422);
    expect((await request("PATCH", `/chats/${chatAid}`, { model_aid: "nosuchmodel000" })).status).toBe(422);
    await db().update(chats).set({ finishedAt: new Date() }).where(eq(chats.aid, chatAid));
    expect((await json(request("PATCH", `/chats/${chatAid}`, { archived: true }))).chat.status).toBe("archived");
    expect((await json(request("PATCH", `/chats/${chatAid}`, { archived: false }))).chat.status).toBe("finished");
  });

  it("削除すると見えなくなり、生成中のメッセージは止まる", async () => {
    const { chat, chatAid } = await setup();
    const [pending] = await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role: MESSAGE_ROLES.assistant, status: MESSAGE_STATUSES.pending, content: [] }).returning();
    expect((await request("DELETE", `/chats/${chatAid}`)).status).toBe(200);
    expect((await post(`/chats/${chatAid}`)).status).toBe(404);
    const [row] = await db().select().from(chatMessages).where(eq(chatMessages.id, pending.id));
    expect(row.status).toBe(MESSAGE_STATUSES.canceled);
  });
});

describe("章の要約", () => {
  it("章をクリアすると次の章へ進み、閉じた章の要約が追記される", async () => {
    const { chatAid } = await setup([{ key: "c1", title: "出会い", objective: "名前を覚えられる" }, { key: "c2", title: "答え", objective: "関係が決まる" }]);
    for (let turn = 0; turn < 2; turn++) {
      await drain((await json(post(`/chats/${chatAid}/messages`, { content: `${turn}回目` }))).message_aid);
    }
    const [chat] = await db().select().from(chats).where(eq(chats.aid, chatAid));
    expect(chat.currentChapterKey).toBe("c2");
    expect(chat.turnsInChapter).toBe(0);
    expect(chat.summaries).toEqual([{ chapter_key: "c1", text: expect.stringMatching(/^（擬似要約）/) }]);
  });
});

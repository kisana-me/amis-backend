import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { aiUsages, characters, chatMessages, chats } from "../src/db/schema";
import { accountRow, cast, ctx, db, fakeMainDb, insertAiModel, insertCharacter, insertPlot } from "./helpers";

const app = () => createApp({ mainDb: () => fakeMainDb([accountRow(1, { name: "きさな" })], [{ token: "me", accountId: 1 }]) });
const post = (path: string, body: unknown = {}) =>
  app().request(`/v1/amis${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer me" },
    body: JSON.stringify(body),
  }, env, ctx);

async function events(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)));
}

async function startChat(chapters: unknown[] = [{ key: "c1", title: "出会い", objective: "名前を覚えられる" }]) {
  await insertAiModel({ provider: "mock" });
  const yuki = await insertCharacter({ name: "ユキ" });
  const plot = await insertPlot({ chapters, openingScene: [{ speaker: null, text: "教室のドアが開いた。" }] });
  await cast(plot.id, yuki.id, { speakerKey: "yuki", isLead: true });
  const started = (await (await post("/chats/create", { plot_aid: plot.aid })).json()) as Record<string, any>;
  return { yuki, plot, chatAid: started.chat.aid as string, started };
}

describe("チャットを始める", () => {
  it("導入を最初の返答として入れ、プロットと主役の遊ばれた回数を数える", async () => {
    const { started, plot, yuki } = await startChat();
    expect(started.messages.map((m: any) => [m.role, m.scene])).toEqual([["assistant", [{ speaker: null, text: "教室のドアが開いた。" }]]]);
    expect(started.chat).toMatchObject({ current_chapter_key: "c1", messages_count: 1, model_aid: expect.any(String) });
    expect(started.pending_message_aid).toBeNull();
    const [p] = await db().select().from(characters).where(eq(characters.id, yuki.id));
    expect(p.chatsCount).toBe(1);
    expect(plot.id).toBeGreaterThan(0);
  });

  it("見られないプロットは 404、使えるモデルが無ければ 422", async () => {
    const closed = await insertPlot({ visibility: 2, authorId: 2 });
    expect((await post("/chats/create", { plot_aid: closed.aid })).status).toBe(404);
    const open = await insertPlot();
    expect((await post("/chats/create", { plot_aid: open.aid })).status).toBe(422);
  });
});

describe("メッセージを送って生成する", () => {
  it("送信 → SSE で snapshot・差分・done が流れ、仕上げで状態・利用記録・進行が残る", async () => {
    const { chatAid, yuki } = await startChat();
    const sent = (await (await post(`/chats/${chatAid}/messages`, { content: "こんにちは" })).json()) as Record<string, any>;
    expect(sent).toMatchObject({ status: "success", queue_position: 0, quota: { weekly_usage_percent: 0 } });

    // 生成が終わるまでは、次の送信は弾かれる
    expect((await post(`/chats/${chatAid}/messages`, { content: "もう一度" })).status).toBe(409);

    const stream = await events(await post(`/messages/${sent.message_aid}/stream`));
    expect(stream[0]).toEqual({ type: "snapshot", seq: 0, scene: [], status: "streaming" });
    const deltas = stream.filter((e) => e.type === undefined);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((e) => e.seq)).toEqual(deltas.map((_, i) => i + 1));
    const done = stream.at(-1)!;
    // 送信の時点で章のターン数が 1 になるので、擬似上流は 2 番目の場所を書く
    expect(done).toMatchObject({ type: "done", status: "normal", scene_status: { place: "旧校舎の階段", time: expect.any(String), air: expect.any(String) } });
    expect(done.scene.map((l: any) => l.speaker)).toEqual([null, "yuki"]);
    // 差分は上流の出力そのまま。確定版はキャラのセリフから「」を外したもの (フロントは done で差し替える)
    expect(deltas.filter((e) => e.i === 1).map((e) => e.delta).join("").replace(/^「(.*)」$/gm, "$1")).toBe(done.scene[1].text);

    const [message] = await db().select().from(chatMessages).where(eq(chatMessages.aid, sent.message_aid));
    expect(message).toMatchObject({ status: 0, meta: expect.objectContaining({ chapter_cleared: false, scene_status: done.scene_status }) });
    const usage = await db().select().from(aiUsages);
    expect(usage).toEqual([expect.objectContaining({ chatMessageId: message.id, finishReason: "stop", costMicro: 0 })]);
    const [chat] = await db().select().from(chats).where(eq(chats.aid, chatAid));
    expect(chat).toMatchObject({ turnsInChapter: 1, messagesCount: 3 });
    const [lead] = await db().select().from(characters).where(eq(characters.id, yuki.id));
    expect(lead.messagesCount).toBe(1);

    // 生成が終わったメッセージにつなぐと、確定版だけを返して閉じる
    const replay = await events(await post(`/messages/${sent.message_aid}/stream`));
    expect(replay.map((e) => e.type)).toEqual(["snapshot", "done"]);
    expect(replay[1].scene).toEqual(done.scene);
  });

  it("3 往復目でねらいを達成すると、最終章ならチャットが完了してクリア数が増える", async () => {
    const { chatAid, plot } = await startChat();
    for (let turn = 0; turn < 3; turn++) {
      const sent = (await (await post(`/chats/${chatAid}/messages`, { content: `${turn}回目` })).json()) as Record<string, any>;
      await events(await post(`/messages/${sent.message_aid}/stream`));
    }
    const shown = (await (await post(`/chats/${chatAid}`)).json()) as Record<string, any>;
    expect(shown.chat).toMatchObject({ status: "finished", finished: true });
    const [p] = await db().select().from(chats).where(eq(chats.aid, chatAid));
    expect(p.finishedAt).not.toBeNull();
    expect(plot.id).toBeGreaterThan(0);
  });

  it("キャンセルすると生成が止まり、そこまでの本文を canceled で残す", async () => {
    const { chatAid } = await startChat();
    const sent = (await (await post(`/chats/${chatAid}/messages`, { content: "こんにちは" })).json()) as Record<string, any>;
    const response = post(`/messages/${sent.message_aid}/stream`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await post(`/messages/${sent.message_aid}/cancel`)).status).toBe(200);
    const done = (await events(await response)).at(-1)!;
    expect(done).toMatchObject({ type: "done", status: "canceled" });
    const [message] = await db().select().from(chatMessages).where(eq(chatMessages.aid, sent.message_aid));
    expect(message.status).toBe(6);
  });

  it("生成中に別の接続でつなぐと、途中経過を読んで差分と確定版が届く", async () => {
    const { chatAid } = await startChat();
    const sent = (await (await post(`/chats/${chatAid}/messages`, { content: "こんにちは" })).json()) as Record<string, any>;
    const first = post(`/messages/${sent.message_aid}/stream`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await events(await post(`/messages/${sent.message_aid}/stream`));
    const done = (await events(await first)).at(-1)!;
    expect(second[0]).toMatchObject({ type: "snapshot", status: "streaming" });
    expect(second.at(-1)).toMatchObject({ type: "done", status: "normal", scene: done.scene });
  });

  it("自動継続はユーザーの発言を作らない。空の本文は自動継続でなければ弾く", async () => {
    const { chatAid } = await startChat();
    expect((await post(`/chats/${chatAid}/messages`, { content: "  " })).status).toBe(422);
    const sent = (await (await post(`/chats/${chatAid}/messages`, { auto: true })).json()) as Record<string, any>;
    await events(await post(`/messages/${sent.message_aid}/stream`));
    const shown = (await (await post(`/chats/${chatAid}`)).json()) as Record<string, any>;
    expect(shown.messages.map((m: any) => m.role)).toEqual(["assistant", "assistant"]);
  });

  it("週の上限に達していたら 403 と weekly_limit を返す", async () => {
    const { chatAid } = await startChat();
    await db().insert(aiUsages).values({ accountId: 1, costMicro: 5_000_000 });
    const res = await post(`/chats/${chatAid}/messages`, { content: "こんにちは" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "weekly_limit" });
  });
});

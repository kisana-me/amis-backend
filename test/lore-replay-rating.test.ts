// 本体の lore_matcher_test / replay_trimmer_test を移したもの (モデルのバリデーションのテストは書き込みの移植のときに移す)
import { describe, expect, it } from "vitest";
import { keywordList, loreBlock, loreHitsFor } from "../src/generation/lore-matcher";
import { keyFor, trim } from "../src/generation/replay-trimmer";
import { rateText } from "../src/generation/text-rating";
import { chatMessages, chats, loreEntries, lores, MESSAGE_ROLES, plotLores } from "../src/db/schema";
import { db, insertPlot, uid } from "./helpers";

async function setup() {
  const plot = await insertPlot();
  const [lore] = await db().insert(lores).values({ aid: uid("lo"), title: "王国史", authorId: 1 }).returning();
  const [forest] = await db().insert(loreEntries).values({ loreId: lore.id, title: "黒森の伝承", keywords: "黒森、森の奥", body: "かつてこの森は王家の狩場だった。" }).returning();
  const [crest] = await db().insert(loreEntries).values({ loreId: lore.id, title: "王家の紋章", keywords: "紋章", body: "三本の剣が交差した意匠。" }).returning();
  await db().insert(plotLores).values({ plotId: plot.id, loreId: lore.id });
  const [chat] = await db().insert(chats).values({ aid: uid("ct"), accountId: 1, plotId: plot.id }).returning();
  const say = async (text: string, role: number = MESSAGE_ROLES.user) =>
    (await db().insert(chatMessages).values({ aid: uid("ms"), chatId: chat.id, role, content: [{ speaker: null, text }] }).returning())[0];
  return { lore, forest, crest, chat, say };
}

describe("LoreMatcher", () => {
  it("直近の会話に出たキーワードの項目だけが当たる", async () => {
    const { chat, forest, say } = await setup();
    await say("あの黒森って何なんだ");
    const hits = await loreHitsFor(db(), chat);
    expect(hits.map((h) => h.entry.id)).toEqual([forest.id]);
    expect(hits[0].keyword).toBe("黒森");
  });

  it("AI の出力に出た固有名詞にも反応する", async () => {
    const { chat, forest, crest, say } = await setup();
    await say("森の奥へ向かう");
    await say("@: 三本の剣が交差した紋章が刻まれていた。", MESSAGE_ROLES.assistant);
    expect((await loreHitsFor(db(), chat)).map((h) => h.entry.id)).toEqual([forest.id, crest.id]);
  });

  it("3往復より前に落ちた語には反応しない", async () => {
    const { chat, say } = await setup();
    await say("あの黒森って何なんだ");
    for (let i = 0; i < 6; i++) await say("そうか");
    expect(await loreHitsFor(db(), chat)).toEqual([]);
  });

  it("全角と大文字小文字の揺れを吸収する", async () => {
    const { chat, lore, say } = await setup();
    await db().insert(loreEntries).values({ loreId: lore.id, title: "旅籠", keywords: "Inn", body: "村で唯一の宿。" });
    await say("ＩＮＮ に泊まる");
    expect((await loreHitsFor(db(), chat)).map((h) => h.entry.title)).toContain("旅籠");
  });

  it("やり直しで捨てた返答は走査から外れる", async () => {
    const { chat, say } = await setup();
    await say("森へ行く");
    const rejected = await say("@: 黒森の話をした。", MESSAGE_ROLES.assistant);
    expect(await loreHitsFor(db(), chat, [rejected.id])).toEqual([]);
  });

  it("ラベルはキーワード列の先頭で当たったものになる", async () => {
    const { chat, say } = await setup();
    await say("森の奥、そして黒森");
    expect((await loreHitsFor(db(), chat))[0].keyword).toBe("黒森");
  });

  it("ブロックは項目タイトルではなく当たったキーワードを見出しにする", async () => {
    const { chat, say } = await setup();
    await say("黒森と紋章");
    const block = loreBlock(await loreHitsFor(db(), chat))!;
    expect(block).toContain("【黒森】かつてこの森は王家の狩場だった。");
    expect(block).not.toContain("黒森の伝承");
  });

  it("キーワードは読点で区切る。改行では区切らない。区切りだけの入力は落とす", () => {
    expect(keywordList("黒森,王家の狩場")).toEqual(["黒森", "王家の狩場"]);
    expect(keywordList("黒森\n王家")).toEqual(["黒森\n王家"]);
    expect(keywordList(" 黒森 、、, 紋章、 ")).toEqual(["黒森", "紋章"]);
    expect(keywordList("、、、")).toEqual([]);
  });

  it("何も当たらなければブロックは作らない", async () => {
    const { chat, say } = await setup();
    await say("いい天気だ");
    expect(await loreHitsFor(db(), chat)).toEqual([]);
    expect(loreBlock([])).toBeNull();
  });

  it("削除された設定集は発火しない", async () => {
    const { chat, lore, say } = await setup();
    await say("黒森へ");
    await db().update(lores).set({ status: 2 });
    expect(lore.id).toBeGreaterThan(0);
    expect(await loreHitsFor(db(), chat)).toEqual([]);
  });
});

describe("ReplayTrimmer", () => {
  const scene = (...texts: string[]) => texts.map((text) => ({ speaker: null, text }));

  it("履歴にある行が先頭から続いているぶんだけ落とす", () => {
    expect(trim(scene("既出A", "既出B", "新規C"), new Set(["既出A", "既出B"]))).toEqual(scene("新規C"));
  });

  it("末尾が違っても行頭が同じなら既出とみなす", () => {
    const known = new Set([keyFor("書架の陰から、聞き慣れない笑い声がした。神楽坂蒼は本棚の隙間に身を潜めていた。")]);
    const lines = scene("書架の陰から、聞き慣れない笑い声がした。神楽坂蒼は、背中を丸めて身を隠している。", "今回のぶん");
    expect(trim(lines, known)).toEqual(scene("今回のぶん"));
  });

  it("先頭が新規なら何も落とさない", () => {
    expect(trim(scene("新規A", "既出B"), new Set(["既出B"]))).toEqual(scene("新規A", "既出B"));
  });

  it("全部が既出なら判断できないので触らない", () => {
    expect(trim(scene("既出A", "既出B"), new Set(["既出A", "既出B"]))).toEqual(scene("既出A", "既出B"));
  });

  it("1行だけの出力と、履歴が空のときは触らない", () => {
    expect(trim(scene("既出A"), new Set(["既出A"]))).toEqual(scene("既出A"));
    expect(trim(scene("A", "B"), new Set())).toEqual(scene("A", "B"));
  });
});

describe("TextRating", () => {
  it("語を含めば nsfw、全角や大文字の揺れも吸収する", () => {
    expect(rateText("")).toBe(0);
    expect(rateText("いい天気")).toBe(0);
    expect(rateText("殺人事件")).toBe(1);
  });
});

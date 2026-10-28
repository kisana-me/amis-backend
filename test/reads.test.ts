import { describe, expect, it } from "vitest";
import { characterImages, loreEntries, lores, personas, plotLikes, plotLores } from "../src/db/schema";
import { accountRow, appWith, cast, db, insertCharacter, insertImage, insertPlot, uid } from "./helpers";

const me = accountRow(1);
const other = accountRow(2);
const app = () => appWith([me, other], [{ token: "me", accountId: 1 }, { token: "other", accountId: 2 }]);

describe("POST /home", () => {
  it("タブで並び順が変わる", async () => {
    await insertPlot({ title: "古い人気", clearsCount: 9, chatsCount: 1 });
    await insertPlot({ title: "話題", clearsCount: 0, chatsCount: 50 });
    await insertPlot({ title: "新着", clearsCount: 1, chatsCount: 0 });
    const titles = async (tab?: string) => (await app().json("/home", { body: tab ? { tab } : {} })).plots.map((p: any) => p.title);
    expect(await titles()).toEqual(["古い人気", "新着", "話題"]);
    expect(await titles("new")).toEqual(["新着", "話題", "古い人気"]);
    expect(await titles("trending")).toEqual(["話題", "古い人気", "新着"]);
  });
});

describe("POST /accounts/@:name_id", () => {
  it("本人には非公開のものも visibility 付きで返し、他人には一覧と同じ見え方。結末の収集は空", async () => {
    await insertPlot({ title: "公開", authorId: 1 });
    await insertPlot({ title: "非公開", authorId: 1, visibility: 2 });
    await insertPlot({ title: "削除済み", authorId: 1, status: 2 });

    const mine = await app().json("/accounts/@user1", { token: "me" });
    expect(mine.mine).toBe(true);
    expect(mine.plots.map((p: any) => [p.title, p.visibility])).toEqual([["非公開", "closed"], ["公開", "opened"]]);
    expect(mine.achievements).toEqual([]);

    const theirs = await app().json("/accounts/@user1", { token: "other" });
    expect(theirs.mine).toBe(false);
    expect(theirs.plots.map((p: any) => p.title)).toEqual(["公開"]);
    expect(theirs.plots[0]).not.toHaveProperty("visibility");
  });

  it("いない・正常でない・公開でないアカウントは 404", async () => {
    const hidden = appWith([accountRow(3, { visibility: 2 }), accountRow(4, { status: 1 })]);
    expect((await hidden.post("/accounts/@user3")).status).toBe(404);
    expect((await hidden.post("/accounts/@user4")).status).toBe(404);
    expect((await hidden.post("/accounts/@nobody")).status).toBe(404);
  });
});

describe("POST /cards", () => {
  it("全年齢以外の絵は伏せる。見せられないものは 404", async () => {
    const icon = await insertImage();
    const general = await insertPlot({ iconId: icon.id, chapters: [{ key: "c" }] });
    const nsfw = await insertCharacter({ iconId: icon.id, userRating: 1 });
    const closed = await insertPlot({ visibility: 2 });

    const plotCard = (await app().json("/cards", { body: { type: "plot", aid: general.aid } })).card;
    expect(plotCard).toMatchObject({ type: "plot", icon_url: expect.stringContaining(icon.aid), author_name: "なまえ1", free_form: false, chapters_count: 1 });
    const characterCard = (await app().json("/cards", { body: { type: "character", aid: nsfw.aid } })).card;
    expect(characterCard.icon_url).toBe("https://api.example.test/static_assets/images/amiverse-1.webp");
    expect(characterCard).not.toHaveProperty("free_form");
    expect((await app().post("/cards", { body: { type: "plot", aid: closed.aid } })).status).toBe(404);
    expect((await app().post("/cards", { body: { type: "other", aid: general.aid } })).status).toBe(404);
  });
});

describe("ロア", () => {
  it("一覧は自分のものだけで、本文の文字数の合計を付ける", async () => {
    const [mine] = await db().insert(lores).values({ aid: uid("lo"), title: "自分", authorId: 1 }).returning();
    await db().insert(lores).values({ aid: uid("lo"), title: "他人", authorId: 2 });
    await db().insert(loreEntries).values([{ loreId: mine.id, keywords: "a", body: "あいう" }, { loreId: mine.id, keywords: "b", body: "えお" }]);
    const body = await app().json("/lores", { token: "me" });
    expect(body.lores.map((l: any) => [l.title, l.body_length, l.mine])).toEqual([["自分", 5, true]]);
  });

  it("詳細は公開されているか自分のものなら読める", async () => {
    const [closed] = await db().insert(lores).values({ aid: uid("lo"), title: "非公開", authorId: 1, visibility: 2 }).returning();
    await db().insert(loreEntries).values({ loreId: closed.id, keywords: "k", body: "本文" });
    expect((await app().post(`/lores/${closed.aid}`, { token: "other" })).status).toBe(404);
    const body = await app().json(`/lores/${closed.aid}`, { token: "me" });
    expect(body.lore.entries).toEqual([{ id: expect.any(Number), title: "", keywords: "k", body: "本文" }]);
    expect(body.lore).not.toHaveProperty("body_length");
  });

  it("ピッカーは自分のものと、他人の公開かつ付けてよいもの。% は文字として探す", async () => {
    await db().insert(lores).values([
      { aid: uid("lo"), title: "自分 100%", authorId: 1, visibility: 2 },
      { aid: uid("lo"), title: "自分 100点", authorId: 1 },
      { aid: uid("lo"), title: "他人 100%", authorId: 2 },
      { aid: uid("lo"), title: "他人 100% 付けられない", authorId: 2, allowAttach: false },
    ]);
    const body = await app().json("/lores/selectable", { token: "me", body: { q: "100%" } });
    expect(body.mine.map((l: any) => l.title)).toEqual(["自分 100%"]);
    expect(body.others.map((l: any) => l.title)).toEqual(["他人 100%"]);
  });
});

describe("POST /personas", () => {
  it("削除していない自分のものを並び順で", async () => {
    await db().insert(personas).values([
      { aid: uid("pe"), accountId: 1, name: "二", position: 1 },
      { aid: uid("pe"), accountId: 1, name: "一", position: 0 },
      { aid: uid("pe"), accountId: 1, name: "削除", status: 2 },
      { aid: uid("pe"), accountId: 2, name: "他人" },
    ]);
    expect((await app().json("/personas", { token: "me" })).personas.map((p: any) => [p.name, p.recommended])).toEqual([["一", false], ["二", false]]);
  });
});

describe("POST /my/likes/plots", () => {
  it("新しい順に 30 件ずつ。カーソルで続きを引き、見られなくなったものは中身を null にする", async () => {
    const plots = [];
    for (let i = 0; i < 31; i++) plots.push(await insertPlot({ title: `p${i}`, visibility: i === 0 ? 2 : 0 }));
    // 古い順にいいねした。同じ時刻のものは対象の id で並ぶ
    await db().insert(plotLikes).values(plots.map((p, i) => ({ accountId: 2, plotId: p.id, createdAt: new Date(1_000_000 + Math.floor(i / 2) * 1000) })));

    const first = await app().post("/my/likes/plots", { token: "other" });
    const cursor = first.headers.get("X-Next-Cursor");
    const page1 = (await first.json()) as any;
    expect(page1.likes).toHaveLength(30);
    expect(page1.likes[0].plot.title).toBe("p30");
    expect(page1.likes.slice(0, 3).map((l: any) => l.plot.title)).toEqual(["p30", "p29", "p28"]);
    expect(cursor).not.toBeNull();

    const second = await app().post("/my/likes/plots", { token: "other", body: { cursor } });
    expect(second.headers.get("X-Next-Cursor")).toBeNull();
    const page2 = (await second.json()) as any;
    expect(page2.likes).toEqual([{ plot_aid: plots[0].aid, liked_at: 1000, plot: null }]);
  });
});

describe("キャラのピッカーと編集", () => {
  it("ピッカーは自分のもの (非公開も) と、他人の出演させてよいもの。公式キャラは他人側に出ない", async () => {
    await insertCharacter({ name: "自分の非公開", authorId: 1, visibility: 2 });
    await insertCharacter({ name: "他人", authorId: 2 });
    await insertCharacter({ name: "他人の出演不可", authorId: 2, allowCasting: false });
    await insertCharacter({ name: "公式", authorId: null });
    const body = await app().json("/characters/selectable", { token: "me" });
    expect(body.mine.map((c: any) => [c.name, c.mine, c.persona])).toEqual([["自分の非公開", true, "定義"]]);
    expect(body.others.map((c: any) => [c.name, c.mine])).toEqual([["他人", false]]);
    expect(body.others[0]).not.toHaveProperty("persona");
  });

  it("編集は自分のものだけ。シークレットの絵も返す", async () => {
    const secret = await insertImage();
    const character = await insertCharacter({ authorId: 1 });
    await db().insert(characterImages).values({ characterId: character.id, imageId: secret.id, secret: true, situation: "照れ" });
    expect((await app().post(`/characters/${character.aid}/edit`, { token: "other" })).status).toBe(404);
    const body = await app().json(`/characters/${character.aid}/edit`, { token: "me" });
    expect(body.character.images).toEqual([expect.objectContaining({ aid: secret.aid, situation: "照れ", secret: true })]);
    expect(body.character).toMatchObject({ has_icon: false, user_rating: "general", visibility: "opened" });
  });
});

describe("POST /plots/:aid/edit", () => {
  it("章のねらい、出演者、付いている設定集の中身を返し、結末は返さない", async () => {
    const character = await insertCharacter({ authorId: 2 });
    const plot = await insertPlot({
      authorId: 1,
      chapters: [{ key: "c1", title: "一", objective: "ねらい", endings: [{ key: "e" }] }],
      openingScene: [{ speaker: "hero", text: "やあ" }],
    });
    await cast(plot.id, character.id, { speakerKey: "hero", roleName: "主人公", isLead: true });
    const [lore] = await db().insert(lores).values({ aid: uid("lo"), title: "他人の設定", authorId: 2 }).returning();
    await db().insert(plotLores).values({ plotId: plot.id, loreId: lore.id });

    expect((await app().post(`/plots/${plot.aid}/edit`, { token: "other" })).status).toBe(404);
    const body = (await app().json(`/plots/${plot.aid}/edit`, { token: "me" })).plot;
    expect(body.chapters).toEqual([{ key: "c1", title: "一", objective: "ねらい" }]);
    expect(body.opening).toEqual([{ speaker: "hero", character_aid: character.aid, text: "やあ", icon: null, image: null }]);
    expect(body.cast[0]).toMatchObject({ speaker_key: "hero", role_name: "主人公", is_lead: true, character: { aid: character.aid, mine: false } });
    expect(body.lores).toEqual([expect.objectContaining({ title: "他人の設定", mine: false, entries: [] })]);
  });
});

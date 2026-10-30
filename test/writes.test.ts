import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { characterImages, characters, images, loreEntries, lores, personas, plotLikes, plots, reports } from "../src/db/schema";
import type { ImageProcessor } from "../src/media/images";
import { accountRow, ctx, db, fakeMainDb, insertCharacter, insertPlot } from "./helpers";

// 画像の変換は Images バインディングの代わりに、受け取ったバイト列をそのまま返す
const processed: string[] = [];
const fakeProcessor: ImageProcessor = async (file, variant) => {
  processed.push(variant);
  return { body: await file.arrayBuffer(), width: 10, height: 10 };
};
const app = () => createApp({ mainDb: () => fakeMainDb([accountRow(1), accountRow(2)], [{ token: "me", accountId: 1 }, { token: "other", accountId: 2 }]), imageProcessor: fakeProcessor });
const send = (method: string, path: string, body?: FormData | object, token = "me") =>
  app().request(`/v1/amis${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
  }, env, ctx);
const json = async (res: Response | Promise<Response>) => (await (await res).json()) as Record<string, any>;
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

function characterForm(values: Record<string, string>, files: { icon?: File; images?: File[] } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(`character[${key}]`, value);
  if (files.icon) form.append("character[icon_file]", files.icon);
  for (const file of files.images ?? []) form.append("character[images_files][]", file);
  return form;
}

describe("キャラの作成・更新・削除", () => {
  it("multipart で作り、アイコンと追加画像を R2 の amis/ に置く。編集用の形で返す", async () => {
    const res = await json(send("POST", "/characters/create", characterForm({
      name: "ユキ", tagline: "一言", description: "説明\r\n2 行目", persona: "定義", persona_public: "false",
      allow_casting: "true", allow_fork: "false", visibility: "closed", user_rating: "nsfw",
      images_json: JSON.stringify([{ image_aid: null, upload: 0, situation: " 笑顔 ", secret: false }, { image_aid: null, upload: 1, situation: "涙", secret: true }]),
    }, { icon: png("icon.png"), images: [png("a.png"), png("b.png")] })));
    expect(res.character).toMatchObject({
      name: "ユキ", description: "説明\n2 行目", visibility: "closed", user_rating: "nsfw", mine: true, has_icon: true, persona: "定義",
    });
    expect(res.character.images.map((i: any) => [i.situation, i.secret])).toEqual([["笑顔", false], ["涙", true]]);
    expect(processed.slice(-3)).toEqual(["amis-character", "amis-character", "amis-character"]);
    const keys = (await env.MEDIA.list({ prefix: "images/variants/" })).objects.map((o) => o.key);
    expect(keys).toContain(res.character.icon_url.replace("https://amis-media.example.test/", ""));
  });

  it("更新では渡したキーだけを変え、画像は並べ替え・削除・追加を 1 回で同期する", async () => {
    const created = await json(send("POST", "/characters/create", characterForm({
      name: "ユキ", persona: "定義",
      images_json: JSON.stringify([{ upload: 0, situation: "一", secret: false }, { upload: 1, situation: "二", secret: false }]),
    }, { images: [png("a.png"), png("b.png")] })));
    const [first, second] = created.character.images;
    const updated = await json(send("PATCH", `/characters/${created.character.aid}`, characterForm({
      tagline: "変えた",
      images_json: JSON.stringify([{ image_aid: second.aid, situation: "二'", secret: true }, { upload: 0, situation: "三", secret: false }]),
    }, { images: [png("c.png")] })));
    expect(updated.character).toMatchObject({ name: "ユキ", tagline: "変えた" });
    expect(updated.character.images.map((i: any) => i.situation)).toEqual(["二'", "三"]);
    expect(updated.character.images[0].aid).toBe(second.aid);
    const rows = await db().select().from(characterImages);
    expect(rows).toHaveLength(2);
    expect(first.aid).not.toBe(second.aid);
  });

  it("検証に通らなければ何も書かない", async () => {
    const before = (await db().select().from(images)).length;
    for (const values of [{ name: "", persona: "定義" } as Record<string, string>, { name: "あ".repeat(51), persona: "定義" }, { name: "ユキ", persona: "" }, { name: "ユキ", persona: "定義", visibility: "secret" }]) {
      expect((await send("POST", "/characters/create", characterForm(values, { icon: png("icon.png") }))).status).toBe(422);
    }
    const missing = await json(send("POST", "/characters/create", characterForm({ name: "ユキ", persona: "定義", images_json: JSON.stringify([{ image_aid: "nosuchimage000" }]) })));
    expect(missing.message).toBe("画像が見つかりませんでした");
    expect(await db().select().from(characters)).toHaveLength(0);
    expect((await db().select().from(images)).length).toBe(before);
    expect((await json(send("POST", "/characters/create", characterForm({ name: "", persona: "" })))).message).toBe("名前を入力してください、定義を入力してください");
  });

  it("他人のキャラは更新も削除もできない。削除はソフトデリート", async () => {
    const mine = await insertCharacter({ authorId: 1 });
    expect((await send("PATCH", `/characters/${mine.aid}`, characterForm({ name: "乗っ取り" }), "other")).status).toBe(404);
    expect((await send("DELETE", `/characters/${mine.aid}`, undefined, "other")).status).toBe(404);
    expect((await send("DELETE", `/characters/${mine.aid}`)).status).toBe(200);
    const [row] = await db().select().from(characters).where(eq(characters.id, mine.id));
    expect(row.status).toBe(2);
  });
});

describe("ペルソナ", () => {
  it("作って、変えて、消す。5 件まで", async () => {
    const created = await json(send("POST", "/personas/create", { name: "きさな", description: "学生" }));
    expect(created.persona).toMatchObject({ name: "きさな", description: "学生", recommended: false });
    const updated = await json(send("PATCH", `/personas/${created.persona.aid}`, { description: "社会人" }));
    expect(updated.persona).toMatchObject({ name: "きさな", description: "社会人" });
    expect((await send("PATCH", `/personas/${created.persona.aid}`, { name: "" })).status).toBe(422);
    for (let i = 0; i < 4; i++) await send("POST", "/personas/create", { name: `p${i}` });
    expect((await json(send("POST", "/personas/create", { name: "6人目" }))).message).toBe("ペルソナは5件までです");
    expect((await send("DELETE", `/personas/${created.persona.aid}`)).status).toBe(200);
    expect((await db().select().from(personas).where(eq(personas.aid, created.persona.aid)))[0].status).toBe(2);
  });
});

describe("いいね", () => {
  it("付けると数え直した数を返し、二度押しでも増えない。外せる。非公開には付けられない", async () => {
    const plot = await insertPlot();
    expect(await json(send("POST", `/plots/${plot.aid}/like`))).toEqual({ status: "success", liked: true, likes_count: 1 });
    expect(await json(send("POST", `/plots/${plot.aid}/like`))).toEqual({ status: "success", liked: true, likes_count: 1 });
    expect(await json(send("POST", `/plots/${plot.aid}/like`, undefined, "other"))).toMatchObject({ likes_count: 2 });
    expect(await json(send("DELETE", `/plots/${plot.aid}/like`))).toEqual({ status: "success", liked: false, likes_count: 1 });
    expect(await db().select().from(plotLikes)).toHaveLength(1);
    const closed = await insertPlot({ visibility: 2 });
    expect((await send("POST", `/plots/${closed.aid}/like`)).status).toBe(404);
    const character = await insertCharacter();
    expect(await json(send("POST", `/characters/${character.aid}/like`))).toMatchObject({ liked: true, likes_count: 1 });
  });
});

describe("設定集", () => {
  it("項目ごと作り、項目を足し引きして更新し、消すとプロットから外れる", async () => {
    const created = await json(send("POST", "/lores/create", { lore: {
      title: "王国史", description: "説明", allow_attach: true, visibility: "opened",
      entries_json: JSON.stringify([{ title: "黒森", keywords: " 黒森 、、, 森の奥 ", body: "狩場" }, { keywords: "紋章", body: "剣" }]),
    } }));
    expect(created.lore).toMatchObject({ title: "王国史", entries_count: 2, mine: true });
    expect(created.lore.entries.map((e: any) => e.keywords)).toEqual(["黒森、森の奥", "紋章"]);

    const [keep] = created.lore.entries;
    const updated = await json(send("PATCH", `/lores/${created.lore.aid}`, { lore: {
      entries_json: JSON.stringify([{ id: keep.id, title: "黒森", keywords: "黒森", body: "変えた" }, { keywords: "王都", body: "都" }]),
    } }));
    expect(updated.lore.entries.map((e: any) => [e.keywords, e.body])).toEqual([["黒森", "変えた"], ["王都", "都"]]);
    expect(updated.lore.entries[0].id).toBe(keep.id);
    expect(updated.lore.entries_count).toBe(2);

    const bad = await json(send("PATCH", `/lores/${created.lore.aid}`, { lore: { entries_json: JSON.stringify([{ keywords: "あ、い、う、え、お、か", body: "" }]) } }));
    expect(bad.message).toBe("項目: キーワードは5つまでです、項目: 本文を入力してください");
    expect(await db().select().from(loreEntries)).toHaveLength(2);

    expect((await send("DELETE", `/lores/${created.lore.aid}`)).status).toBe(200);
    expect((await db().select().from(lores))[0].status).toBe(2);
    expect(await db().select().from(plots)).toHaveLength(0);
  });
});

// 本体の test/services/amis/plot_writer_test.rb を移したもの (結末は廃止したので保存されないことを確かめる)
describe("プロットの作成・更新・削除", () => {
  function plotForm(values: Record<string, unknown>, files: File[] = []) {
    const base = { title: "転校生", description: "紹介文。", situation: "春の教室。", visibility: "closed", user_rating: "general", allow_fork: "false" };
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...base, ...values })) {
      form.append(`plot[${key}]`, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const file of files) form.append("plot[images_files][]", file);
    return form;
  }
  const create = (values: Record<string, unknown>, files?: File[]) => json(send("POST", "/plots/create", plotForm(values, files)));
  const update = (aid: string, values: Record<string, unknown>, files?: File[]) => json(send("PATCH", `/plots/${aid}`, plotForm(values, files)));

  async function twoCharacters() {
    return [await insertCharacter({ name: "ユキ", authorId: 1 }), await insertCharacter({ name: "Ren Kai", authorId: 1 })];
  }

  it("出演・導入・推奨ペルソナをまとめて作る。章 (chapters_json) は受け取っても無視する", async () => {
    const [yuki, ren] = await twoCharacters();
    const res = await create({
      cast_json: [{ character_aid: yuki.aid, role_name: "同級生", is_lead: "true" }, { character_aid: ren.aid, role_name: "友人", is_lead: "false" }],
      chapters_json: [{ key: "ch1", title: "出会い", objective: "名前を覚えられる", endings: [{ key: "lover", title: "恋人になる" }] }],
      opening_json: [{ character_aid: null, text: "教室のドアが開いた。" }, { character_aid: yuki.aid, text: "……あ、きみが噂の転校生？" }],
      personas_json: [{ name: "転校生", description: "きたばかり" }],
    });
    expect(res.status).toBe("success");
    expect(res.plot.cast.map((c: any) => [c.speaker_key, c.is_lead, c.role_name])).toEqual([["cast", true, "同級生"], ["renkai", false, "友人"]]);
    expect(res.plot).not.toHaveProperty("chapters");
    expect(res.plot.recommended_personas.map((p: any) => p.name)).toEqual(["転校生"]);
    // 導入の話者は character_aid から speaker_key に解決される
    expect(res.plot.opening.map((l: any) => [l.speaker, l.character_aid])).toEqual([[null, null], ["cast", yuki.aid]]);
    const [plot] = await db().select().from(plots);
    expect(plot.authorId).toBe(1);
    expect((await db().select().from(characters).where(eq(characters.id, yuki.id)))[0].leadsCount).toBe(1);
  });

  it("主役の指定が無ければ先頭が主役になる", async () => {
    const [yuki, ren] = await twoCharacters();
    const res = await create({ cast_json: [{ character_aid: ren.aid }, { character_aid: yuki.aid }] });
    expect(res.plot.cast.map((c: any) => c.is_lead)).toEqual([true, false]);
  });

  it("出演から外したキャラは導入から消えて地の文になり、主役の数も数え直す", async () => {
    const [yuki, ren] = await twoCharacters();
    const created = await create({ cast_json: [{ character_aid: yuki.aid, is_lead: "true" }], opening_json: [{ character_aid: yuki.aid, text: "こんにちは" }] });
    const updated = await update(created.plot.aid, { cast_json: [{ character_aid: ren.aid, is_lead: "true" }], opening_json: [{ character_aid: yuki.aid, text: "こんにちは" }] });
    expect(updated.plot.cast.map((c: any) => c.character.aid)).toEqual([ren.aid]);
    expect(updated.plot.opening[0].speaker).toBeNull();
    expect((await db().select().from(characters).where(eq(characters.id, yuki.id)))[0].leadsCount).toBe(0);
  });

  it("外した推奨ペルソナはソフトデリートされる", async () => {
    const created = await create({ personas_json: [{ name: "転校生" }] });
    await update(created.plot.aid, { personas_json: [] });
    expect((await db().select().from(personas))[0].status).toBe(2);
  });

  it("出演がいなければ公開できず、他人の出演不可のキャラは出せない", async () => {
    expect((await create({ visibility: "opened", cast_json: [] })).message).toContain("出演キャラが1人以上必要");
    const guarded = await insertCharacter({ name: "非公開", authorId: 2, allowCasting: false });
    expect((await create({ cast_json: [{ character_aid: guarded.aid }] })).message).toContain("出演させられません");
  });

  it("画像は状況とシークレットを持って並び順どおりに入り、image_aid で残して外れた行は消える。挿絵は添字で指せる", async () => {
    const created = await create({
      images_json: [{ upload: 0, situation: "序盤", secret: false }, { upload: 1, situation: "結末", secret: true }],
      opening_json: [{ character_aid: null, text: "扉が開いた。", image_index: 1 }],
    }, [png("a.png"), png("b.png")]);
    expect(created.plot.images.map((i: any) => [i.situation, i.secret])).toEqual([["序盤", false], ["結末", true]]);
    const [kept, removed] = created.plot.images.map((i: any) => i.aid);
    expect(created.plot.opening[0].image).toBe(removed);

    const updated = await update(created.plot.aid, { images_json: [{ image_aid: kept, situation: "書き換えた" }] });
    expect(updated.plot.images.map((i: any) => [i.aid, i.situation])).toEqual([[kept, "書き換えた"]]);
  });

  it("他人のプロットは更新も削除もできない", async () => {
    const created = await create({});
    expect((await send("PATCH", `/plots/${created.plot.aid}`, plotForm({ title: "乗っ取り" }), "other")).status).toBe(404);
    expect((await send("DELETE", `/plots/${created.plot.aid}`, undefined, "other")).status).toBe(404);
    expect((await send("DELETE", `/plots/${created.plot.aid}`)).status).toBe(200);
  });
});

describe("通報", () => {
  it("キャラとプロットを通報できる。未サインインでもよい。非公開や存在しないものは弾く", async () => {
    const plot = await insertPlot({ visibility: 1 });
    const res = await send("POST", "/reports", { report: { target_type: "amis_plot", target_aid: plot.aid, category: "spam", description: "宣伝" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "success", message: "通報しました" });
    const anonymous = await app().request("/v1/amis/reports", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: { target_type: "amis_character", target_aid: (await insertCharacter()).aid } }),
    }, env, ctx);
    expect(anonymous.status).toBe(201);

    const closed = await insertPlot({ visibility: 2 });
    const rejected = await json(send("POST", "/reports", { report: { target_type: "amis_plot", target_aid: closed.aid } }));
    expect(rejected).toEqual({ status: "error", message: "通報できませんでした", errors: ["通報対象のプロットが見つかりませんでした"] });
    expect((await send("POST", "/reports", { report: { target_type: "post", target_aid: plot.aid } })).status).toBe(422);
    const rows = await db().select().from(reports);
    expect(rows.map((r) => [r.targetType, r.category, r.accountId])).toEqual([["amis_plot", 1, 1], ["amis_character", 0, null]]);
  });
});

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { characterImages, characters, images, loreEntries, lores, personas, plotLikes, plots } from "../src/db/schema";
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
    const keys = (await env.MEDIA.list({ prefix: "amis/images/variants/" })).objects.map((o) => o.key);
    expect(keys).toContain(res.character.icon_url.replace("https://media.example.test/", ""));
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

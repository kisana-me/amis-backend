import { describe, expect, it } from "vitest";
import { characterImages, characterLikes, RATINGS } from "../src/db/schema";
import { accountRow, appWith, cast, db, insertCharacter, insertImage, insertPlot } from "./helpers";

const author = accountRow(1, { icon_aid: "authoricon", icon_status: 0, icon_variant_type: "account", icon_rating: 0 });
const minor = accountRow(2, { adult: 0 });
const app = () => appWith([author, minor], [{ token: "author", accountId: 1 }, { token: "minor", accountId: 2 }]);

type Json = Record<string, any>;

describe("POST /characters", () => {
  it("公開・正常・見られるレーティングのものだけを、人気順で返す", async () => {
    await insertCharacter({ name: "人気", chatsCount: 10 });
    await insertCharacter({ name: "普通", chatsCount: 5 });
    await insertCharacter({ name: "非公開", visibility: 2, chatsCount: 99 });
    await insertCharacter({ name: "ロック", status: 1, chatsCount: 99 });
    await insertCharacter({ name: "却下", autoRating: RATINGS.rejected, chatsCount: 99 });
    await insertCharacter({ name: "r18", userRating: RATINGS.r18, chatsCount: 50 });

    const names = async (token?: string) =>
      ((await (await app().post("/characters", { token })).json()) as Json).characters.map((c: Json) => c.name);
    // 成人は r18 まで、未成年と未サインインは nsfw まで
    expect(await names("author")).toEqual(["r18", "人気", "普通"]);
    expect(await names("minor")).toEqual(["人気", "普通"]);
    expect(await names()).toEqual(["人気", "普通"]);
  });

  it("本体の _character.json.jbuilder と同じ形", async () => {
    const icon = await insertImage();
    await insertCharacter({ name: "公開定義", iconId: icon.id, personaPublic: true, persona: "見える定義", tagline: "一言" });
    await insertCharacter({ name: "公式", authorId: null });

    const list = ((await (await app().post("/characters")).json()) as Json).characters as Json[];
    const open = list.find((c) => c.name === "公開定義")!;
    expect(open).toEqual({
      aid: expect.any(String), name: "公開定義", tagline: "一言", description: "",
      icon_url: `https://media.example.test/amis/images/variants/${icon.aid}.webp`,
      rating: "general", official: false,
      author: { name: "なまえ1", name_id: "user1", icon_url: "https://media.example.test/images/variants/authoricon.webp" },
      leads_count: 0, chats_count: 0, likes_count: 0, allow_fork: false, persona: "見える定義",
    });
    const official = list.find((c) => c.name === "公式")!;
    expect(official.official).toBe(true);
    expect(official.author).toBeNull();
    expect(official).not.toHaveProperty("persona");
    expect(official.icon_url).toBe("https://api.example.test/static_assets/images/amiverse-logo.webp");
  });
});

describe("POST /characters/:aid", () => {
  it("見つからない・見せられないものは 404。非公開でも作者本人には見せる", async () => {
    const closed = await insertCharacter({ visibility: 2 });
    expect((await app().post("/characters/nosuchaid")).status).toBe(404);
    expect((await app().post(`/characters/${closed.aid}`)).status).toBe(404);
    expect((await app().post(`/characters/${closed.aid}`, { token: "minor" })).status).toBe(404);
    expect((await app().post(`/characters/${closed.aid}`, { token: "author" })).status).toBe(200);
  });

  it("画像はアイコンが先頭でシークレットを除く。主役と脇役のプロット、いいね、脇役の数を返す", async () => {
    const icon = await insertImage();
    const extra = await insertImage({ name: "立ち絵" });
    const secret = await insertImage();
    const nsfw = await insertImage({ userRating: RATINGS.nsfw });
    const character = await insertCharacter({ iconId: icon.id, messagesCount: 7 });
    await db().insert(characterImages).values([
      { characterId: character.id, imageId: nsfw.id, position: 2 },
      { characterId: character.id, imageId: secret.id, position: 0, secret: true },
      { characterId: character.id, imageId: extra.id, position: 1 },
    ]);
    await db().insert(characterLikes).values({ accountId: 1, characterId: character.id });

    const other = await insertCharacter({ name: "相方" });
    const lead = await insertPlot({ title: "主役", clearsCount: 1, chapters: [{ key: "c1" }, { key: "c2" }] });
    await cast(lead.id, other.id, { position: 0 });
    await cast(lead.id, character.id, { position: 1, isLead: true });
    const support = await insertPlot({ title: "脇役" });
    await cast(support.id, character.id);
    const hidden = await insertPlot({ title: "非公開", visibility: 2 });
    await cast(hidden.id, character.id);

    const body = (await (await app().post(`/characters/${character.aid}`, { token: "minor" })).json()) as Json;
    expect(body.character.images.map((i: Json) => i.aid)).toEqual([icon.aid, extra.aid, nsfw.aid]);
    expect(body.character.images[1]).toEqual({
      type: "image", aid: extra.aid, name: "立ち絵", description: "",
      url: `https://media.example.test/amis/images/variants/${extra.aid}.webp`, rating: "general",
    });
    expect(body.character).toMatchObject({ messages_count: 7, casts_count: 2, liked: false });

    expect(body.lead_plots.map((p: Json) => p.title)).toEqual(["主役"]);
    expect(body.cast_plots.map((p: Json) => p.title)).toEqual(["脇役"]);
    const plot = body.lead_plots[0];
    expect(plot).toMatchObject({ free_form: false, chapters_count: 2, clears_count: 1, official: false });
    expect(plot.cast.map((c: Json) => [c.character.name, c.is_lead])).toEqual([["相方", false], ["キャラ", true]]);
    expect(plot.lead_character.aid).toBe(character.aid);
    expect(body.cast_plots[0]).toMatchObject({ free_form: true, chapters_count: 0 });

    const mine = (await (await app().post(`/characters/${character.aid}`, { token: "author" })).json()) as Json;
    expect(mine.character.liked).toBe(true);
  });
});

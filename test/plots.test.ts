import { describe, expect, it } from "vitest";
import { characterImages, chats, lores, personas, plotImages, plotLores } from "../src/db/schema";
import { accountRow, appWith, cast, db, insertCharacter, insertImage, insertPlot, uid } from "./helpers";

const me = accountRow(1);
const app = () => appWith([me], [{ token: "tok", accountId: 1 }]);

type Json = Record<string, any>;

describe("POST /plots", () => {
  it("クリア数の多い順に、公開されているものだけ", async () => {
    await insertPlot({ title: "少ない", clearsCount: 1 });
    await insertPlot({ title: "多い", clearsCount: 9 });
    await insertPlot({ title: "非公開", clearsCount: 99, visibility: 2 });
    const body = (await (await app().post("/plots")).json()) as Json;
    expect(body.plots.map((p: Json) => p.title)).toEqual(["多い", "少ない"]);
  });
});

describe("POST /plots/:aid", () => {
  it("導入・挿絵・章・公開のロア・ペルソナ・続きのチャットを返し、結末は返さない", async () => {
    const face = await insertImage();
    const scenery = await insertImage();
    const secretShot = await insertImage();
    const character = await insertCharacter();
    await db().insert(characterImages).values({ characterId: character.id, imageId: face.id });

    const plot = await insertPlot({
      chapters: [{ key: "c1", title: "はじまり", objective: "秘密", endings: [{ key: "e" }] }, { key: "c2" }, "壊れた行"],
      openingScene: [
        { speaker: "", text: "地の文", image: scenery.aid },
        { speaker: "s1", text: "せりふ", icon: face.aid },
        { speaker: "s1", text: "   " },
      ],
      situationPublic: true,
      situation: "状況",
    });
    await cast(plot.id, character.id, { isLead: true });
    await db().insert(plotImages).values([
      { plotId: plot.id, imageId: scenery.id, position: 0 },
      { plotId: plot.id, imageId: secretShot.id, position: 1, secret: true },
    ]);

    const [openLore] = await db().insert(lores).values({ aid: uid("lo"), title: "公開の設定" }).returning();
    const [closedLore] = await db().insert(lores).values({ aid: uid("lo"), title: "非公開の設定", visibility: 2 }).returning();
    await db().insert(plotLores).values([{ plotId: plot.id, loreId: openLore.id }, { plotId: plot.id, loreId: closedLore.id }]);
    await db().insert(personas).values([
      { aid: uid("pe"), plotId: plot.id, name: "二番目", position: 1 },
      { aid: uid("pe"), plotId: plot.id, name: "一番目", position: 0 },
      { aid: uid("pe"), plotId: plot.id, name: "削除済み", status: 2 },
    ]);
    await db().insert(chats).values([
      { aid: uid("ct"), accountId: 1, plotId: plot.id, lastMessageAt: new Date("2026-10-01T00:00:00Z") },
      { aid: uid("ct"), accountId: 1, plotId: plot.id, title: "新しい", status: 1, lastMessageAt: new Date("2026-10-02T00:00:00Z") },
      { aid: uid("ct"), accountId: 1, plotId: plot.id, status: 2, lastMessageAt: new Date("2026-10-03T00:00:00Z") },
    ]);

    const body = (await (await app().post(`/plots/${plot.aid}`, { token: "tok" })).json()) as Json;
    expect(body.plot.opening).toEqual([
      { speaker: null, text: "地の文", image: scenery.aid },
      { speaker: "s1", text: "せりふ", icon: face.aid },
    ]);
    expect(Object.keys(body.plot.scene_images).sort()).toEqual([face.aid, scenery.aid].sort());
    expect(body.plot.chapters).toEqual([{ key: "c1", title: "はじまり" }, { key: "c2", title: "" }]);
    expect(body.plot).toMatchObject({ chapters_count: 2, free_form: false, situation: "状況", liked: false });
    expect(body.plot).not.toHaveProperty("endings");
    expect(body.plot.images.map((i: Json) => i.aid)).toEqual([scenery.aid]);
    expect(body.plot.lores.map((l: Json) => l.title)).toEqual(["公開の設定"]);
    expect(body.recommended_personas.map((p: Json) => [p.name, p.recommended, p.icon_url])).toEqual([["一番目", true, null], ["二番目", true, null]]);
    expect(body.latest_chat).toEqual({
      aid: expect.any(String), display_title: "新しい", finished: true,
      last_message_at: Date.parse("2026-10-02T00:00:00Z") / 1000,
    });
  });

  it("導入が画像を名指ししていなければ scene_images を出さない。未サインインなら続きのチャットは null", async () => {
    const plot = await insertPlot({ openingScene: [{ speaker: null, text: "地の文" }] });
    const body = (await (await app().post(`/plots/${plot.aid}`)).json()) as Json;
    expect(body.plot).not.toHaveProperty("scene_images");
    expect(body.plot).not.toHaveProperty("situation");
    expect(body.latest_chat).toBeNull();
  });
});

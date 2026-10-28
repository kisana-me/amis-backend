import { describe, expect, it } from "vitest";
import { aiUsages, RATINGS } from "../src/db/schema";
import { accountRow, appWith, cast, db, insertAiModel, insertCharacter, insertPlot } from "./helpers";

const me = accountRow(1);
const app = () => appWith([me], [{ token: "tok", accountId: 1 }]);

describe("POST /status", () => {
  it("サインインしていなければ 401", async () => {
    expect((await app().post("/status")).status).toBe(401);
  });

  it("今週の原価だけを数えて、上限に対する割合を返す", async () => {
    const now = Date.now();
    await db().insert(aiUsages).values([
      { accountId: 1, costMicro: 1_000_000, createdAt: new Date(now) },
      { accountId: 1, costMicro: 250_000, createdAt: new Date(now) },
      { accountId: 1, costMicro: 9_000_000, createdAt: new Date(now - 8 * 24 * 3600_000) },
      { accountId: 2, costMicro: 9_000_000, createdAt: new Date(now) },
    ]);
    const res = await app().post("/status", { token: "tok" });
    expect(await res.json()).toMatchObject({ status: "success", quota: { weekly_usage_percent: 25 }, queue_position: 0 });
  });

  it("モデルは並び順で返し、プロットのレーティングで使えるかどうかと既定を付ける", async () => {
    await insertAiModel({ name: "premium", tier: 1, position: 0 });
    await insertAiModel({ name: "nsfw まで", position: 1, maxRating: RATINGS.nsfw });
    await insertAiModel({ name: "r18 まで", position: 2, maxRating: RATINGS.r18 });
    await insertAiModel({ name: "停止中", position: 3, status: 1 });

    const plot = await insertPlot({ userRating: RATINGS.general });
    await cast(plot.id, (await insertCharacter({ userRating: RATINGS.r18 })).id);

    const plain = (await (await app().post("/status", { token: "tok" })).json()) as { models: { name: string; allowed: boolean; default: boolean }[] };
    expect(plain.models.map((m) => [m.name, m.allowed, m.default])).toEqual([
      ["premium", true, false], ["nsfw まで", true, true], ["r18 まで", true, false],
    ]);

    // 出演者が r18 なので、プロットの内容は r18 として見る
    const withPlot = (await (await app().post("/status", { token: "tok", body: { plot_aid: plot.aid } })).json()) as typeof plain;
    expect(withPlot.models.map((m) => [m.name, m.allowed, m.default])).toEqual([
      ["premium", true, false], ["nsfw まで", false, false], ["r18 まで", true, true],
    ]);
    expect(withPlot.models[0]).toEqual({ aid: expect.any(String), name: "premium", tier: "premium", max_rating: "r18", allowed: true, default: false });
  });
});

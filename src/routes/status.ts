import { asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { aiModels, AI_MODEL_TIERS, CONTENT_STATUSES, characters, plotCharacters } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody } from "../lib/http";
import { maxRatingFor, ratingLabel, selfRating } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { findVisiblePlot } from "../queries/visibility";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";
import type { Plot } from "../views/context";

const TIER_LABELS = ["free", "premium"] as const;

export const statusRoutes = new Hono<AppEnv>();

// 週の利用率と、選べる AI モデルの一覧 (本体の V1::Amis::StatusController)。
// plot_aid を渡すと、そのプロットのレーティングで使えるかどうかの印も付ける。一覧からは消さない
statusRoutes.post("/status", requireSignin, async (c) => {
  const account = c.var.currentAccount!;
  const body = await jsonBody(c);
  const plot = typeof body.plot_aid === "string" && body.plot_aid
    ? await findVisiblePlot(c.var.db, body.plot_aid, maxRatingFor(account), account)
    : null;
  const rating = plot ? await contentRating(c.var.db, plot) : null;

  const [models, spent] = await Promise.all([
    c.var.db.select().from(aiModels).where(eq(aiModels.status, CONTENT_STATUSES.normal))
      .orderBy(asc(aiModels.position), asc(aiModels.inputPriceMicro), asc(aiModels.id)),
    weeklyCostMicro(c.var.db, account.id),
  ]);
  const allows = (maxRating: number) => rating === null || maxRating >= rating;
  // 何も選ばなかったときに使うモデル。premium は既定にしない (本体の AiModel.default_for)
  const defaultModel = models.find((m) => m.tier === AI_MODEL_TIERS.free && allows(m.maxRating));

  return c.json({
    status: "success",
    quota: { weekly_usage_percent: usagePercent(spent, Number(c.env.WEEKLY_COST_LIMIT_MICRO)) },
    // 順番待ちのキューはなくなった。フロントが数として読むので 0 を返す
    queue_position: 0,
    models: models.map((m) => ({
      aid: m.aid,
      name: m.name,
      tier: TIER_LABELS[m.tier] ?? "free",
      max_rating: ratingLabel(m.maxRating),
      allowed: allows(m.maxRating),
      default: m.id === defaultModel?.id,
    })),
  });
});

// このプロットで生成される内容のレーティング。出演者込みで見る (本体の Plot#content_rating)。
// 画像は上流に送らないので derived_rating は入れない
export async function contentRating(db: Db, plot: Plot): Promise<number> {
  const cast = await db.select().from(characters).where(
    inArray(characters.id, db.select({ id: plotCharacters.characterId }).from(plotCharacters).where(eq(plotCharacters.plotId, plot.id))),
  );
  return Math.max(selfRating(plot), ...cast.map(selfRating));
}

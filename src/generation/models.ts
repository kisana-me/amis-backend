// 生成に使う AI モデルの選び方と原価 (本体の AiModel / ChatService#resolve_model!)
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { AI_MODEL_TIERS, aiModels, CONTENT_STATUSES, characters, plotCharacters } from "../db/schema";
import { selfRating } from "../lib/ratings";
import type { AiModel, Plot } from "../views/context";

// 価格は「100 万トークンあたりのマイクロ USD」で持つ
const PRICE_UNIT_TOKENS = 1_000_000;

export class ModelUnavailable extends Error {}

// このプロットで生成される内容のレーティング。出演者込みで見る (本体の Plot#content_rating)。
// 画像は上流に送らないので derived_rating は入れない
export async function contentRating(db: Db, plot: Plot): Promise<number> {
  const cast = await db.select().from(characters).where(
    inArray(characters.id, db.select({ id: plotCharacters.characterId }).from(plotCharacters).where(eq(plotCharacters.plotId, plot.id))),
  );
  return Math.max(selfRating(plot), ...cast.map(selfRating));
}

export const allowsRating = (model: AiModel, rating: number) => model.maxRating >= rating;

// モデルを明示しなかったとき、および指定が使えなくなっていたときに落ちる先。premium は既定にしない
export async function defaultModel(db: Db, rating: number): Promise<AiModel | null> {
  const [model] = await db.select().from(aiModels)
    .where(and(eq(aiModels.status, CONTENT_STATUSES.normal), gte(aiModels.maxRating, rating), eq(aiModels.tier, AI_MODEL_TIERS.free)))
    .orderBy(asc(aiModels.position), asc(aiModels.inputPriceMicro), asc(aiModels.id)).limit(1);
  return model ?? null;
}

export async function findModelByAid(db: Db, aid: unknown): Promise<AiModel | null> {
  if (typeof aid !== "string" || aid.trim() === "") return null;
  const [model] = await db.select().from(aiModels).where(eq(aiModels.aid, aid)).limit(1);
  return model ?? null;
}

export async function findModelById(db: Db, id: number | null): Promise<AiModel | null> {
  if (id === null) return null;
  const [model] = await db.select().from(aiModels).where(eq(aiModels.id, id)).limit(1);
  return model ?? null;
}

// 選んでいない (null) なら既定に落とす。選択済みのモデルが使えなくなっているときは黙って差し替えず、はっきり断る。
// 黙って替えると、運営が一時的に停止しただけで利用者の選択が消えてしまう
export async function resolveModel(db: Db, rating: number, model: AiModel | null): Promise<AiModel> {
  const resolved = model === null ? await defaultModel(db, rating) : model;
  if (resolved === null) throw new ModelUnavailable("利用可能なモデルがありません");
  if (resolved.status !== CONTENT_STATUSES.normal) {
    throw new ModelUnavailable("選択中のモデルはいま使えません。設定からモデルを変更してください");
  }
  if (!allowsRating(resolved, rating)) {
    throw new ModelUnavailable("このプロットのレーティングでは使えないモデルです。設定からモデルを変更してください");
  }
  return resolved;
}

// 生成の直前に使うモデル。停止・削除されたモデルを指しているだけなら既定に落とす (本体の AiModel.usable)
export async function usableModel(db: Db, rating: number, model: AiModel | null): Promise<AiModel | null> {
  return model?.status === CONTENT_STATUSES.normal ? model : defaultModel(db, rating);
}

export function costMicro(model: AiModel, usage: { promptTokens: number; cachedTokens: number; completionTokens: number }): number {
  const miss = Math.max(usage.promptTokens - usage.cachedTokens, 0);
  const total = miss * model.inputPriceMicro + usage.cachedTokens * model.cachedInputPriceMicro + usage.completionTokens * model.outputPriceMicro;
  return Math.round(total / PRICE_UNIT_TOKENS);
}

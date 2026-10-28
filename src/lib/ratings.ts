// 本体の Rateable と同じ。user / auto / mod の 3 軸で、rating は D1 の生成カラム
import { RATINGS } from "../db/schema";

const LABELS = ["general", "nsfw", "r18", "rejected"] as const;

export type Viewer = { adult: boolean } | null;

export function ratingLabel(rating: number | null): string {
  return LABELS[rating ?? -1] ?? "general";
}

// 見せてよいレーティングの上限。年齢の確認が要るのは r18 だけ
export function maxRatingFor(viewer: Viewer): number {
  return viewer?.adult ? RATINGS.r18 : RATINGS.nsfw;
}

// derived_rating (紐づく画像由来) を除いた、自分自身のレーティング。AI モデルのゲートに使う
export function selfRating(row: { userRating: number; autoRating: number | null; modRating: number | null }): number {
  if (row.modRating !== null) return row.modRating;
  return Math.max(row.userRating, row.autoRating ?? 0);
}

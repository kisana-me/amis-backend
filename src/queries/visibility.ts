// 本体の V1::Amis::ApplicationController#visible_* / own_amis_record と同じ条件
import { and, eq, lt, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { CONTENT_STATUSES, characters, plots, RATINGS, VISIBILITIES } from "../db/schema";

// 一覧に出してよいもの: 正常・公開・rejected でない・見ている人のレーティングの上限以下
export const visibleCharacters = (maxRating: number) =>
  and(
    eq(characters.status, CONTENT_STATUSES.normal),
    eq(characters.visibility, VISIBILITIES.opened),
    lt(characters.rating, RATINGS.rejected),
    lte(characters.rating, maxRating),
  );

export const visiblePlots = (maxRating: number) =>
  and(
    eq(plots.status, CONTENT_STATUSES.normal),
    eq(plots.visibility, VISIBILITIES.opened),
    lt(plots.rating, RATINGS.rejected),
    lte(plots.rating, maxRating),
  );

// 非公開やレーティングで一覧に出ないものでも、作者本人のものは通す。
// 運営がロックしたもの (locked) は作者にも返さないので normal だけ
export const ownCharacter = (accountId: number) =>
  and(eq(characters.status, CONTENT_STATUSES.normal), eq(characters.authorId, accountId));

export const ownPlot = (accountId: number) =>
  and(eq(plots.status, CONTENT_STATUSES.normal), eq(plots.authorId, accountId));

type Viewer = { id: number } | null;

// 一覧に見えるものを探し、なければ作者本人のものを探す (本体の visible_* || own_amis_record)
export async function findVisibleCharacter(db: Db, aid: string, maxRating: number, viewer: Viewer) {
  const [visible] = await db.select().from(characters).where(and(eq(characters.aid, aid), visibleCharacters(maxRating))).limit(1);
  if (visible || !viewer) return visible ?? null;
  const [own] = await db.select().from(characters).where(and(eq(characters.aid, aid), ownCharacter(viewer.id))).limit(1);
  return own ?? null;
}

export async function findVisiblePlot(db: Db, aid: string, maxRating: number, viewer: Viewer) {
  const [visible] = await db.select().from(plots).where(and(eq(plots.aid, aid), visiblePlots(maxRating))).limit(1);
  if (visible || !viewer) return visible ?? null;
  const [own] = await db.select().from(plots).where(and(eq(plots.aid, aid), ownPlot(viewer.id))).limit(1);
  return own ?? null;
}

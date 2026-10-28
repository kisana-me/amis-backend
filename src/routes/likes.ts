// いいねの一覧 (本体の V1::Amis::LikesController#index)。
// 見られなくなったものも行としては残し、一覧からいいねを外せるようにする
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { inChunks } from "../db/client";
import { CONTENT_STATUSES, characterLikes, characters, plotLikes, plots } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { visibleCharacters, visiblePlots } from "../queries/visibility";
import { loadContext, loadersOf } from "../views/context";
import { characterJson, plotJson } from "../views/json";

const LIMIT = 30;

export const likeRoutes = new Hono<AppEnv>();

// 次のページのカーソル。D1 のいいねは id を持たないので「いいねした時刻.対象の id」で表す
function parseCursor(value: unknown): { at: Date; targetId: number } | null {
  if (typeof value !== "string") return null;
  const [at, targetId] = value.split(".").map(Number);
  return Number.isFinite(at) && Number.isFinite(targetId) ? { at: new Date(at), targetId } : null;
}

// カーソルより後ろ (古い側) の行。いいねした時刻、同じなら対象の id で並べる
function olderThan(cursor: unknown, createdAt: AnySQLiteColumn, targetId: AnySQLiteColumn): SQL | undefined {
  const after = parseCursor(cursor);
  if (!after) return undefined;
  return or(lt(createdAt, after.at), and(eq(createdAt, after.at), lt(targetId, after.targetId)));
}

likeRoutes.post("/my/likes/plots", requireSignin, async (c) => {
  const { db } = c.var;
  const viewer = c.var.currentAccount!;
  const cursor = (await jsonBody(c)).cursor;
  const likes = await db.select().from(plotLikes)
    .where(and(eq(plotLikes.accountId, viewer.id), olderThan(cursor, plotLikes.createdAt, plotLikes.plotId)))
    .orderBy(desc(plotLikes.createdAt), desc(plotLikes.plotId)).limit(LIMIT);
  const ids = likes.map((l) => l.plotId);

  // aid は見えるかどうかに関わらず引く (見られなくなった対象もいいねを外せるように)。
  // 中身は一覧と同じ基準で絞り、作者本人のものは非公開でも出す
  const targets = await inChunks(ids, (chunk) => db.select().from(plots).where(inArray(plots.id, chunk)));
  const visible = await inChunks(ids, (chunk) => db.select({ id: plots.id }).from(plots).where(and(inArray(plots.id, chunk),
    or(visiblePlots(maxRatingFor(viewer)), and(eq(plots.status, CONTENT_STATUSES.normal), eq(plots.authorId, viewer.id))))));
  const visibleIds = new Set(visible.map((v) => v.id));
  const byId = new Map(targets.map((p) => [p.id, p]));
  const ctx = await loadContext(loadersOf(c), { plots: targets.filter((p) => visibleIds.has(p.id)) });

  if (likes.length === LIMIT) c.header("X-Next-Cursor", cursorOf(likes.at(-1)!.createdAt, likes.at(-1)!.plotId));
  return c.json({
    status: "success",
    likes: likes.map((like) => {
      const plot = byId.get(like.plotId);
      return {
        plot_aid: plot?.aid ?? null,
        liked_at: Math.floor(like.createdAt.getTime() / 1000),
        // 非公開・削除・レーティング超過は中身を返さない。表示側がプレースホルダに差し替える
        plot: plot && visibleIds.has(plot.id) ? plotJson(plot, ctx) : null,
      };
    }),
  });
});

likeRoutes.post("/my/likes/characters", requireSignin, async (c) => {
  const { db } = c.var;
  const viewer = c.var.currentAccount!;
  const cursor = (await jsonBody(c)).cursor;
  const likes = await db.select().from(characterLikes)
    .where(and(eq(characterLikes.accountId, viewer.id), olderThan(cursor, characterLikes.createdAt, characterLikes.characterId)))
    .orderBy(desc(characterLikes.createdAt), desc(characterLikes.characterId)).limit(LIMIT);
  const ids = likes.map((l) => l.characterId);

  const targets = await inChunks(ids, (chunk) => db.select().from(characters).where(inArray(characters.id, chunk)));
  const visible = await inChunks(ids, (chunk) => db.select({ id: characters.id }).from(characters).where(and(inArray(characters.id, chunk),
    or(visibleCharacters(maxRatingFor(viewer)), and(eq(characters.status, CONTENT_STATUSES.normal), eq(characters.authorId, viewer.id))))));
  const visibleIds = new Set(visible.map((v) => v.id));
  const byId = new Map(targets.map((ch) => [ch.id, ch]));
  const ctx = await loadContext(loadersOf(c), { characters: targets.filter((ch) => visibleIds.has(ch.id)) });

  if (likes.length === LIMIT) c.header("X-Next-Cursor", cursorOf(likes.at(-1)!.createdAt, likes.at(-1)!.characterId));
  return c.json({
    status: "success",
    likes: likes.map((like) => {
      const character = byId.get(like.characterId);
      return {
        character_aid: character?.aid ?? null,
        liked_at: Math.floor(like.createdAt.getTime() / 1000),
        character: character && visibleIds.has(character.id) ? characterJson(character, ctx) : null,
      };
    }),
  });
});

const cursorOf = (at: Date, targetId: number) => `${at.getTime()}.${targetId}`;

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  CHAT_STATUSES, CONTENT_STATUSES, characterImages, chats, lores, personas, plotImages, plotLikes, plotLores, plots, VISIBILITIES,
} from "../db/schema";
import type { AppEnv } from "../env";
import { notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { findVisiblePlot, visiblePlots } from "../queries/visibility";
import { type Loaders, loadCasts, loadContext } from "../views/context";
import { chapterDefinitions, imageDisplayUrl, imageJson, imageUrl, openingImageAids, openingLines, plotJson } from "../views/json";

const LIMIT = 50;

export const plotRoutes = new Hono<AppEnv>();

const loaders = (c: { var: AppEnv["Variables"]; env: AppEnv["Bindings"] }): Loaders => ({
  db: c.var.db, mainDb: c.var.mainDb, env: c.env, viewer: c.var.currentAccount,
});

// クリア数の多い順 (本体の plots#index)
plotRoutes.post("/plots", async (c) => {
  const rows = await c.var.db.select().from(plots)
    .where(visiblePlots(maxRatingFor(c.var.currentAccount)))
    .orderBy(desc(plots.clearsCount), desc(plots.id))
    .limit(LIMIT);
  const ctx = await loadContext(loaders(c), { plots: rows });
  return c.json({ status: "success", plots: rows.map((p) => plotJson(p, ctx)) });
});

// 本体の plots#show。一覧に出ないものでも作者本人には見せる。結末 (endings) は廃止した
plotRoutes.post("/plots/:aid", async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount;
  const plot = await findVisiblePlot(db, c.req.param("aid"), maxRatingFor(account), account);
  if (!plot) return notFound(c, "プロットが見つかりませんでした");

  const [images, attachedLores, recommended, [latest], [like]] = await Promise.all([
    // シークレットも含めて position, id の順。導入が名指しした絵はシークレットからも探す
    db.select({ imageId: plotImages.imageId, secret: plotImages.secret }).from(plotImages)
      .where(eq(plotImages.plotId, plot.id)).orderBy(asc(plotImages.position), asc(plotImages.id)),
    // 付いている設定集のうち公開されているものだけ。非公開のものは付いていること自体を出さない
    db.select({ aid: lores.aid, title: lores.title, description: lores.description }).from(plotLores)
      .innerJoin(lores, eq(lores.id, plotLores.loreId))
      .where(and(eq(plotLores.plotId, plot.id), eq(lores.status, CONTENT_STATUSES.normal), eq(lores.visibility, VISIBILITIES.opened)))
      .orderBy(sql`${plotLores}.rowid`),
    db.select().from(personas)
      .where(and(eq(personas.plotId, plot.id), ne(personas.status, CONTENT_STATUSES.deleted)))
      .orderBy(asc(personas.position), asc(personas.id)),
    // 続きから遊べるチャット。開始ボタンの飛び先になる
    account
      ? db.select().from(chats)
        .where(and(eq(chats.accountId, account.id), eq(chats.plotId, plot.id), inArray(chats.status, [CHAT_STATUSES.normal, CHAT_STATUSES.finished])))
        .orderBy(desc(chats.lastMessageAt), desc(chats.id)).limit(1)
      : Promise.resolve([]),
    account
      ? db.select({ accountId: plotLikes.accountId }).from(plotLikes)
        .where(and(eq(plotLikes.accountId, account.id), eq(plotLikes.plotId, plot.id))).limit(1)
      : Promise.resolve([]),
  ]);

  const casts = await loadCasts(db, [plot]);
  const castCharacterIds = (casts.get(plot.id) ?? []).map((cast) => cast.character.id);
  const castImages = castCharacterIds.length === 0 ? [] : await db.select({ characterId: characterImages.characterId, imageId: characterImages.imageId })
    .from(characterImages).where(inArray(characterImages.characterId, castCharacterIds))
    .orderBy(asc(characterImages.position), asc(characterImages.id));

  // カルーセルはカード画像を先頭に、その後ろへシークレットでない追加ぶんを並べる
  const carouselIds = [plot.iconId, ...images.filter((i) => !i.secret).map((i) => i.imageId)].filter((id): id is number => id !== null);
  // 導入の画像は、プロットの絵 → 出演者の絵 (出演順) の中から探す
  const byCharacter = new Map<number, number[]>();
  for (const row of castImages) byCharacter.set(row.characterId, [...(byCharacter.get(row.characterId) ?? []), row.imageId]);
  const candidateIds = [...images.map((i) => i.imageId), ...castCharacterIds.flatMap((id) => byCharacter.get(id) ?? [])];

  const ctx = await loadContext(loaders(c), {
    plots: [plot],
    casts,
    imageIds: [...carouselIds, ...candidateIds, ...recommended.map((p) => p.iconId).filter((id): id is number => id !== null)],
  });

  const wanted = new Set(openingImageAids(plot));
  const sceneImages: Record<string, string> = {};
  for (const id of candidateIds) {
    const image = ctx.images.get(id);
    if (image && wanted.has(image.aid) && !(image.aid in sceneImages)) sceneImages[image.aid] = imageDisplayUrl(image, ctx);
  }

  return c.json({
    status: "success",
    plot: {
      ...plotJson(plot, ctx),
      opening: openingLines(plot),
      // jbuilder はブロックの中で何も書かないとキーごと出さないので、空なら付けない
      ...(Object.keys(sceneImages).length > 0 ? { scene_images: sceneImages } : {}),
      ...(plot.situationPublic ? { situation: plot.situation } : {}),
      images: carouselIds.flatMap((id) => {
        const image = ctx.images.get(id);
        return image ? [imageJson(image, ctx)] : [];
      }),
      chapters: chapterDefinitions(plot),
      lores: attachedLores,
      liked: like !== undefined,
    },
    recommended_personas: recommended.map((p) => {
      const icon = p.iconId === null ? undefined : ctx.images.get(p.iconId);
      return {
        aid: p.aid, name: p.name, description: p.description, is_default: p.isDefault, position: p.position,
        icon_url: icon ? imageUrl(icon, ctx) : null,
        recommended: p.plotId !== null,
      };
    }),
    latest_chat: latest
      ? {
        aid: latest.aid,
        display_title: latest.title.trim() !== "" ? latest.title : plot.title,
        finished: latest.status === CHAT_STATUSES.finished,
        last_message_at: latest.lastMessageAt ? Math.floor(latest.lastMessageAt.getTime() / 1000) : null,
      }
      : null,
  });
});

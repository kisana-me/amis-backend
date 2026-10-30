import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { savePlot } from "../writers/plot";
import {
  CHAT_STATUSES, CONTENT_STATUSES, characterImages, chats, lores, personas, plotImages, plotLikes, plotLores, plots, VISIBILITIES,
} from "../db/schema";
import { ratingLabel } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { characterImagesOf, entriesOf, imageIdsOf, plotImagesOf } from "../queries/related";
import type { AppEnv } from "../env";
import { jsonBody, limitParam, notFound, sortParam } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { findVisiblePlot, visiblePlots } from "../queries/visibility";
import { loadCasts, loadContext, loadersOf, type Plot } from "../views/context";
import {
  editableCharacterJson, editableLoreJson, imageDisplayUrl, imageJson, imageUrl,
  openingImageAids, openingLines, ownedImageJson, plotIconUrl, plotJson, visibilityLabel,
} from "../views/json";

const LIMIT = 50;
const SORTS = ["popular", "new", "trending"] as const;

export const plotRoutes = new Hono<AppEnv>();

// 公開されているプロットの一覧 (本体の plots#index と home#index)。sort で並び順を変える
plotRoutes.post("/plots", async (c) => {
  const body = await jsonBody(c);
  const sort = sortParam(body.sort, SORTS);
  const order =
    sort === "new" ? [desc(plots.id)]
    : sort === "trending" ? [desc(plots.chatsCount), desc(plots.id)]
    // いいね数がランキングの主指標
    : [desc(plots.likesCount), desc(plots.chatsCount), desc(plots.id)];

  const rows = await c.var.db.select().from(plots)
    .where(visiblePlots(maxRatingFor(c.var.currentAccount)))
    .orderBy(...order)
    .limit(limitParam(body.limit, LIMIT));
  const ctx = await loadContext(loadersOf(c), { plots: rows });
  return c.json({ status: "success", plots: rows.map((p) => plotJson(p, ctx)) });
});

// 編集用。公開向けの show と違い、章のねらいや非公開設定、付いている設定集の中身まで返す (本体の plots#edit)
async function plotEditJson(c: Context<AppEnv>, plot: Plot) {
  const { db } = c.var;
  const viewer = c.var.currentAccount!;

  const [casts, images, attached, recommended] = await Promise.all([
    loadCasts(db, [plot]),
    plotImagesOf(db, plot.id),
    // 他人のものでも中身まで返す。何が AI に渡るのか分からないまま公開させないため
    db.select({ lore: lores }).from(plotLores).innerJoin(lores, eq(lores.id, plotLores.loreId))
      .where(eq(plotLores.plotId, plot.id)).orderBy(sql`${plotLores}.rowid`),
    db.select().from(personas).where(and(eq(personas.plotId, plot.id), ne(personas.status, CONTENT_STATUSES.deleted)))
      .orderBy(asc(personas.position), asc(personas.id)),
  ]);
  const cast = casts.get(plot.id) ?? [];
  const attachedLores = attached.map((row) => row.lore);
  const [owned, entries] = await Promise.all([
    characterImagesOf(db, cast.map((x) => x.character.id)),
    entriesOf(db, attachedLores.map((l) => l.id)),
  ]);
  const ctx = await loadContext(loadersOf(c), {
    plots: [plot], casts, lores: attachedLores,
    imageIds: [...images.map((i) => i.imageId), ...imageIdsOf(owned.values())],
  });

  return {
    status: "success",
    plot: {
      aid: plot.aid, title: plot.title, tagline: plot.tagline, description: plot.description,
      situation: plot.situation, situation_public: plot.situationPublic, allow_fork: plot.allowFork,
      visibility: visibilityLabel(plot.visibility),
      user_rating: ratingLabel(plot.userRating),
      rating: ratingLabel(plot.rating),
      icon_url: plotIconUrl(plot, ctx),
      has_icon: plot.iconId !== null && ctx.images.has(plot.iconId),
      images: images.flatMap((o) => ownedImageJson(o, ctx)),
      opening: openingLines(plot).map((line) => ({
        speaker: line.speaker,
        character_aid: cast.find((x) => x.plotCharacter.speakerKey === line.speaker)?.character.aid ?? null,
        text: line.text,
        icon: line.icon ?? null,
        image: line.image ?? null,
      })),
      cast: cast.map(({ plotCharacter, character }) => ({
        speaker_key: plotCharacter.speakerKey,
        role_name: plotCharacter.roleName,
        role_description: plotCharacter.roleDescription,
        is_lead: plotCharacter.isLead,
        character: editableCharacterJson(character, ctx, viewer.id, owned.get(character.id) ?? []),
      })),
      lores: attachedLores.map((lore) => editableLoreJson(lore, entries.get(lore.id) ?? [], ctx, viewer.id)),
      recommended_personas: recommended.map((p) => ({ aid: p.aid, name: p.name, description: p.description })),
    },
  };
}

async function findOwnPlot(c: Context<AppEnv>, aid: string): Promise<Plot | null> {
  const [plot] = await c.var.db.select().from(plots)
    .where(and(eq(plots.aid, aid), ne(plots.status, CONTENT_STATUSES.deleted), eq(plots.authorId, c.var.currentAccount!.id))).limit(1);
  return plot ?? null;
}

plotRoutes.post("/plots/:aid/edit", requireSignin, async (c) => {
  const plot = await findOwnPlot(c, c.req.param("aid"));
  if (!plot) return notFound(c, "プロットが見つかりませんでした");
  return c.json(await plotEditJson(c, plot));
});

plotRoutes.post("/plots/create", requireSignin, async (c) => {
  const result = await savePlot(c, null);
  if (!result.ok) return c.json({ status: "error", message: result.message }, 422);
  return c.json(await plotEditJson(c, (await findOwnPlot(c, result.aid))!));
});

plotRoutes.patch("/plots/:aid", requireSignin, async (c) => {
  const plot = await findOwnPlot(c, c.req.param("aid"));
  if (!plot) return notFound(c, "プロットが見つかりませんでした");
  const result = await savePlot(c, plot);
  if (!result.ok) return c.json({ status: "error", message: result.message }, 422);
  return c.json(await plotEditJson(c, (await findOwnPlot(c, result.aid))!));
});

plotRoutes.delete("/plots/:aid", requireSignin, async (c) => {
  const plot = await findOwnPlot(c, c.req.param("aid"));
  if (!plot) return notFound(c, "プロットが見つかりませんでした");
  await c.var.db.update(plots).set({ status: CONTENT_STATUSES.deleted }).where(eq(plots.id, plot.id));
  return c.json({ status: "success" });
});

// 本体の plots#show。一覧に出ないものでも作者本人には見せる
plotRoutes.post("/plots/:aid{[a-z0-9]{14}}", async (c) => {
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
        .where(and(eq(chats.accountId, account.id), eq(chats.plotId, plot.id), eq(chats.status, CHAT_STATUSES.normal)))
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

  const ctx = await loadContext(loadersOf(c), {
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
        last_message_at: latest.lastMessageAt ? Math.floor(latest.lastMessageAt.getTime() / 1000) : null,
      }
      : null,
  });
});

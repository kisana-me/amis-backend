import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { CONTENT_STATUSES, characterImages, characterLikes, characters, plotCharacters, plots } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody, notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { characterImagesOf, containing, imageIdsOf } from "../queries/related";
import { findVisibleCharacter, visibleCharacters, visiblePlots } from "../queries/visibility";
import { type Character, loadContext, loadersOf } from "../views/context";
import { characterJson, editableCharacterJson, imageJson, plotJson } from "../views/json";

const LIMIT = 50;
const SELECTABLE_LIMIT = 100;

// 削除していない自分のキャラ (本体の own_characters)
const ownCharacters = (accountId: number) => and(ne(characters.status, CONTENT_STATUSES.deleted), eq(characters.authorId, accountId));

export const characterRoutes = new Hono<AppEnv>();

// 人気順 (本体の characters#index)
characterRoutes.post("/characters", async (c) => {
  const rows = await c.var.db.select().from(characters)
    .where(visibleCharacters(maxRatingFor(c.var.currentAccount)))
    .orderBy(desc(characters.chatsCount), desc(characters.id))
    .limit(LIMIT);
  const ctx = await loadContext(loadersOf(c), { characters: rows });
  return c.json({ status: "success", characters: rows.map((ch) => characterJson(ch, ctx)) });
});

// プロットに出演させられるキャラ。自分のキャラ (非公開も) を先頭に、
// その後ろへ他人の allow_casting なキャラを並べる (本体の characters#selectable)
characterRoutes.post("/characters/selectable", requireSignin, async (c) => {
  const { db } = c.var;
  const viewer = c.var.currentAccount!;
  const query = String((await jsonBody(c)).q ?? "").trim();
  const search = query ? containing(characters.name, query) : undefined;

  const [mine, others] = await Promise.all([
    db.select().from(characters).where(and(ownCharacters(viewer.id), search)).orderBy(desc(characters.id)).limit(SELECTABLE_LIMIT),
    db.select().from(characters)
      .where(and(visibleCharacters(maxRatingFor(viewer)), eq(characters.allowCasting, true), ne(characters.authorId, viewer.id), search))
      .orderBy(desc(characters.chatsCount), desc(characters.id)).limit(SELECTABLE_LIMIT),
  ]);
  const owned = await characterImagesOf(db, [...mine, ...others].map((ch) => ch.id));
  const ctx = await loadContext(loadersOf(c), { characters: [...mine, ...others], imageIds: imageIdsOf(owned.values()) });
  const json = (ch: Character) => editableCharacterJson(ch, ctx, viewer.id, owned.get(ch.id) ?? []);
  return c.json({ status: "success", mine: mine.map(json), others: others.map(json) });
});

// 編集用。persona_public に関わらず定義まで返す (本体の characters#edit)
characterRoutes.post("/characters/:aid/edit", requireSignin, async (c) => {
  const viewer = c.var.currentAccount!;
  const [character] = await c.var.db.select().from(characters)
    .where(and(eq(characters.aid, c.req.param("aid")), ownCharacters(viewer.id))).limit(1);
  if (!character) return notFound(c, "キャラが見つかりませんでした");

  const owned = await characterImagesOf(c.var.db, [character.id]);
  const ctx = await loadContext(loadersOf(c), { characters: [character], imageIds: imageIdsOf(owned.values()) });
  return c.json({ status: "success", character: editableCharacterJson(character, ctx, viewer.id, owned.get(character.id) ?? []) });
});

// 本体の characters#show。一覧に出ないものでも作者本人には見せる
characterRoutes.post("/characters/:aid", async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount;
  const maxRating = maxRatingFor(account);

  const character = await findVisibleCharacter(db, c.req.param("aid"), maxRating, account);
  if (!character) return notFound(c, "キャラが見つかりませんでした");

  const plotsWhere = (isLead: boolean) =>
    and(
      visiblePlots(maxRating),
      inArray(plots.id, db.select({ id: plotCharacters.plotId }).from(plotCharacters)
        .where(and(eq(plotCharacters.characterId, character.id), eq(plotCharacters.isLead, isLead)))),
    );
  const [leadPlots, castPlots, publicImages, [casts], [like]] = await Promise.all([
    db.select().from(plots).where(plotsWhere(true)).orderBy(desc(plots.clearsCount), desc(plots.id)).limit(LIMIT),
    db.select().from(plots).where(plotsWhere(false)).orderBy(desc(plots.clearsCount), desc(plots.id)).limit(LIMIT),
    // シークレット指定の絵は公開のカルーセルには出さない
    db.select({ imageId: characterImages.imageId }).from(characterImages)
      .where(and(eq(characterImages.characterId, character.id), eq(characterImages.secret, false)))
      .orderBy(asc(characterImages.position), asc(characterImages.id)),
    // 脇役で出ているプロットの数。プロットの状態は見ない (本体の casts_count)
    db.select({ n: count() }).from(plotCharacters)
      .where(and(eq(plotCharacters.characterId, character.id), eq(plotCharacters.isLead, false))),
    account
      ? db.select({ accountId: characterLikes.accountId }).from(characterLikes)
        .where(and(eq(characterLikes.accountId, account.id), eq(characterLikes.characterId, character.id))).limit(1)
      : Promise.resolve([]),
  ]);

  // カルーセルはアイコンを先頭に、その後ろへ追加ぶんを並べる
  const imageIds = [character.iconId, ...publicImages.map((r) => r.imageId)].filter((id): id is number => id !== null);
  const ctx = await loadContext(loadersOf(c), { characters: [character], plots: [...leadPlots, ...castPlots], imageIds });

  return c.json({
    status: "success",
    character: {
      ...characterJson(character, ctx),
      images: imageIds.flatMap((id) => {
        const image = ctx.images.get(id);
        return image ? [imageJson(image, ctx)] : [];
      }),
      messages_count: character.messagesCount,
      casts_count: casts?.n ?? 0,
      liked: like !== undefined,
    },
    lead_plots: leadPlots.map((p) => plotJson(p, ctx)),
    cast_plots: castPlots.map((p) => plotJson(p, ctx)),
  });
});

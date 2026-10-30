import { and, asc, count, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { saveCharacter } from "../writers/character";
import { CONTENT_STATUSES, characterImages, characterLikes, characters, plotCharacters, plots } from "../db/schema";
import type { AppEnv } from "../env";
import { castBoolean, jsonBody, limitParam, notFound, queryParam, sortParam } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { requireSignin, signinRequired } from "../middleware/auth";
import { characterImagesOf, containing, imageIdsOf } from "../queries/related";
import { findVisibleCharacter, visibleCharacters, visiblePlots } from "../queries/visibility";
import { type Character, loadContext, loadersOf } from "../views/context";
import { characterJson, editableCharacterJson, imageJson, plotJson } from "../views/json";

const LIMIT = 50;
const SORTS = ["popular", "new"] as const;

// 削除していない自分のキャラ (本体の own_characters)
const ownCharacters = (accountId: number) => and(ne(characters.status, CONTENT_STATUSES.deleted), eq(characters.authorId, accountId));

export const characterRoutes = new Hono<AppEnv>();

// キャラの一覧 (本体の characters#index と characters#selectable)。
// author: "me" なら自分のもの (非公開も)、それ以外は一覧に出るもの。
// castable なら見ている人がプロットに出演させられるものだけ (自分のものと、他人の allow_casting なもの。公式は出演させられない)。
// include: ["images"] なら、ピッカー用に表情差分まで付けた編集向けの形で返す
characterRoutes.post("/characters", async (c) => {
  const { db } = c.var;
  const viewer = c.var.currentAccount;
  const body = await jsonBody(c);
  const mineOnly = body.author === "me";
  if (mineOnly && !viewer) return signinRequired(c);

  const query = queryParam(body.q);
  const castable = castBoolean(body.castable)
    ? or(viewer ? eq(characters.authorId, viewer.id) : undefined, and(eq(characters.allowCasting, true), isNotNull(characters.authorId)))
    : undefined;
  const order = sortParam(body.sort, SORTS) === "new" ? [desc(characters.id)] : [desc(characters.chatsCount), desc(characters.id)];

  const rows = await db.select().from(characters)
    .where(and(
      mineOnly ? ownCharacters(viewer!.id) : visibleCharacters(maxRatingFor(viewer)),
      castable,
      query ? containing(characters.name, query) : undefined,
    ))
    .orderBy(...order)
    .limit(limitParam(body.limit, LIMIT));

  if (!(Array.isArray(body.include) && body.include.includes("images"))) {
    const ctx = await loadContext(loadersOf(c), { characters: rows });
    return c.json({ status: "success", characters: rows.map((ch) => characterJson(ch, ctx)) });
  }
  const owned = await characterImagesOf(db, rows.map((ch) => ch.id));
  const ctx = await loadContext(loadersOf(c), { characters: rows, imageIds: imageIdsOf(owned.values()) });
  return c.json({
    status: "success",
    characters: rows.map((ch) => editableCharacterJson(ch, ctx, viewer?.id ?? null, owned.get(ch.id) ?? [])),
  });
});

// 編集用。persona_public に関わらず定義まで返す (本体の characters#edit)
characterRoutes.post("/characters/:aid/edit", requireSignin, async (c) => {
  const character = await findOwnCharacter(c, c.req.param("aid"));
  if (!character) return notFound(c, "キャラが見つかりませんでした");
  return c.json(await characterEditJson(c, character));
});

const MAX_CHARACTERS = 50;

characterRoutes.post("/characters/create", requireSignin, async (c) => {
  const [{ n }] = await c.var.db.select({ n: count() }).from(characters).where(ownCharacters(c.var.currentAccount!.id));
  if (n >= MAX_CHARACTERS) return c.json({ status: "error", message: `キャラは${MAX_CHARACTERS}体までです` }, 422);

  const result = await saveCharacter(c, null);
  if (!result.ok) return c.json({ status: "error", message: result.message }, 422);
  return c.json(await characterEditJson(c, (await findOwnCharacter(c, result.aid))!));
});

characterRoutes.patch("/characters/:aid", requireSignin, async (c) => {
  const character = await findOwnCharacter(c, c.req.param("aid"));
  if (!character) return notFound(c, "キャラが見つかりませんでした");

  const result = await saveCharacter(c, character);
  if (!result.ok) return c.json({ status: "error", message: result.message }, 422);
  return c.json(await characterEditJson(c, (await findOwnCharacter(c, result.aid))!));
});

// プロットと同じくソフトデリート。出演していたプロットからは消えるが、すでに始まっているチャットはそのまま続けられる
characterRoutes.delete("/characters/:aid", requireSignin, async (c) => {
  const character = await findOwnCharacter(c, c.req.param("aid"));
  if (!character) return notFound(c, "キャラが見つかりませんでした");
  await c.var.db.update(characters).set({ status: CONTENT_STATUSES.deleted }).where(eq(characters.id, character.id));
  return c.json({ status: "success" });
});

async function findOwnCharacter(c: Context<AppEnv>, aid: string): Promise<Character | null> {
  const [character] = await c.var.db.select().from(characters)
    .where(and(eq(characters.aid, aid), ownCharacters(c.var.currentAccount!.id))).limit(1);
  return character ?? null;
}

// characters/edit.json.jbuilder
async function characterEditJson(c: Context<AppEnv>, character: Character) {
  const owned = await characterImagesOf(c.var.db, [character.id]);
  const ctx = await loadContext(loadersOf(c), { characters: [character], imageIds: imageIdsOf(owned.values()) });
  return { status: "success", character: editableCharacterJson(character, ctx, c.var.currentAccount!.id, owned.get(character.id) ?? []) };
}

// 本体の characters#show。一覧に出ないものでも作者本人には見せる
characterRoutes.post("/characters/:aid{[a-z0-9]{14}}", async (c) => {
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
    db.select().from(plots).where(plotsWhere(true)).orderBy(desc(plots.likesCount), desc(plots.id)).limit(LIMIT),
    db.select().from(plots).where(plotsWhere(false)).orderBy(desc(plots.likesCount), desc(plots.id)).limit(LIMIT),
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

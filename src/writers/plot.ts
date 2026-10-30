// プロット + 出演 + 導入 + 推奨ペルソナ + 設定集 + 画像を 1 回の保存で同期する (本体の Amis::PlotWriter と
// Plot / PlotCharacter / Persona のバリデーション、OpeningSceneValidator)。
// キャラと同じく、検証 → 画像を R2 に置く → 行の書き込みを 1 回の batch に、の順にする
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Context } from "hono";
import { inChunks } from "../db/client";
import {
  CONTENT_STATUSES, characterImages, characters, images, lores, personas, plotCharacters, plotImages, plotLores, plots, VISIBILITIES,
} from "../db/schema";
import type { AppEnv } from "../env";
import { charLength, isBlank, rubyStrip } from "../generation/ruby-text";
import { newAid } from "../lib/aid";
import { ValidationErrors } from "../lib/errors";
import { readForm } from "../lib/form";
import { ImageInvalid, storeImage } from "../media/images";
import { plotImagesOf } from "../queries/related";
import type { Character, Plot } from "../views/context";
import type { SaveResult } from "./character";
import { bool, enumValue, normalizeNewlines, optionalText, parseJsonRows, requiredText, USER_RATING_KEYS, VISIBILITY_KEYS } from "./common";
import { planImages } from "./image-sync";

const MAX_CAST = 10;
const MAX_PERSONAS = 5;
// 1 ターンに載りうる分量が青天井にならないよう、冊数だけは締める
const MAX_LORES = 5;
const MAX_OPENING_LINES = 30;
// 1 行の長さは出力規約の地の文に合わせる。導入だけ極端に長いと本文の見本にならない
const MAX_OPENING_TEXT = 300;

type Batch = BatchItem<"sqlite">[];
const ref = <T,>(value: unknown) => value as T;

export async function savePlot(c: Context<AppEnv>, current: Plot | null): Promise<SaveResult> {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const form = await readForm(c, "plot");
  const errors = new ValidationErrors();

  // --- プロット本体 ---------------------------------------------------------
  const values: Partial<typeof plots.$inferInsert> = {};
  if (form.has("title")) values.title = form.get("title") ?? "";
  if (form.has("tagline")) values.tagline = form.get("tagline") ?? "";
  if (form.has("description")) values.description = normalizeNewlines(form.get("description") ?? "");
  if (form.has("situation")) values.situation = normalizeNewlines(form.get("situation") ?? "");
  if (form.has("situation_public")) values.situationPublic = bool(form.get("situation_public"));
  if (form.has("allow_fork")) values.allowFork = bool(form.get("allow_fork"));
  if (form.has("visibility")) values.visibility = enumValue(errors, "公開状態", VISIBILITY_KEYS, form.get("visibility"));
  if (form.has("user_rating")) values.userRating = enumValue(errors, "レーティング", USER_RATING_KEYS, form.get("user_rating"));

  requiredText(errors, "タイトル", values.title ?? current?.title ?? "", 100);
  optionalText(errors, "一言紹介", values.tagline ?? current?.tagline ?? "", 100);
  optionalText(errors, "紹介文", values.description ?? current?.description ?? "", 2000);
  // 毎ターン system プロンプトに載る
  optionalText(errors, "状況設定", values.situation ?? current?.situation ?? "", 10000);

  // 送られてこなかった配列は空として扱う (本体と同じ)
  const castRows = parseJsonRows(errors, "出演", form.get("cast_json")) ?? [];
  const personaRows = parseJsonRows(errors, "推奨ペルソナ", form.get("personas_json")) ?? [];
  const loreRows = parseJsonRows(errors, "設定集", form.get("lores_json")) ?? [];
  const openingRows = parseJsonRows(errors, "導入", form.get("opening_json")) ?? [];
  const imageRows = parseJsonRows(errors, "画像", form.get("images_json")) ?? [];
  if (errors.any) return { ok: false, message: errors.toSentence() };

  if (castRows.length > MAX_CAST) errors.add(`出演キャラは${MAX_CAST}人までです`);
  if (personaRows.length > MAX_PERSONAS) errors.add(`推奨ペルソナは${MAX_PERSONAS}件までです`);
  if (loreRows.length > MAX_LORES) errors.add(`設定集は${MAX_LORES}冊までです`);
  // 出演がいないプロットは遊べないので、公開だけを止める (下書きのまま保存はできる)
  if ((values.visibility ?? current?.visibility ?? VISIBILITIES.opened) === VISIBILITIES.opened && castRows.length === 0) {
    errors.add("公開するには出演キャラが1人以上必要です");
  }
  if (errors.any) return { ok: false, message: errors.toSentence() };

  // --- 出演 -----------------------------------------------------------------
  const existingCast = current
    ? await db.select({ pc: plotCharacters, character: characters }).from(plotCharacters)
      .innerJoin(characters, eq(characters.id, plotCharacters.characterId)).where(eq(plotCharacters.plotId, current.id))
    : [];
  const castByAid = new Map(existingCast.map((row) => [row.character.aid, row]));
  const usedKeys = new Set(existingCast.map((row) => row.pc.speakerKey));
  const requested = castRows.map((row) => String(row.character_aid ?? ""));
  const candidates = await inChunks(requested.filter((aid) => !castByAid.has(aid)), (chunk) =>
    db.select().from(characters).where(and(inArray(characters.aid, chunk), ne(characters.status, CONTENT_STATUSES.deleted))));
  const candidateByAid = new Map(candidates.map((ch) => [ch.aid, ch]));

  type CastPlan = { existingId: number | null; character: Character; speakerKey: string; roleName: string; roleDescription: string; isLead: boolean };
  const cast: CastPlan[] = [];
  let leadTaken = false;
  for (const row of castRows) {
    const aid = String(row.character_aid ?? "");
    if (cast.some((plan) => plan.character.aid === aid)) {
      errors.add("出演: キャラは既に出演しています");
      break;
    }
    const existing = castByAid.get(aid);
    const character = existing?.character ?? castableCharacter(errors, candidateByAid.get(aid), account.id);
    if (!character) break;

    const roleName = String(row.role_name ?? "");
    const roleDescription = String(row.role_description ?? "");
    optionalText(errors, "出演: 役", roleName, 50);
    // キャラ本体の定義への上書きぶんなので、本体 (2000) より短くて足りる
    optionalText(errors, "出演: このプロットでの設定", roleDescription, 500);
    const isLead: boolean = !leadTaken && String(row.is_lead) === "true";
    leadTaken ||= isLead;
    cast.push({
      existingId: existing?.pc.id ?? null, character, roleName, roleDescription, isLead,
      speakerKey: existing?.pc.speakerKey ?? speakerKeyFor(character.name, usedKeys),
    });
  }
  // 主役未指定なら先頭を主役にする。統計の帰属先が無いと集計が落ちる
  if (!leadTaken && cast[0]) cast[0].isLead = true;

  // --- 推奨ペルソナ ---------------------------------------------------------
  const existingPersonas = current
    ? await db.select().from(personas).where(and(eq(personas.plotId, current.id), ne(personas.status, CONTENT_STATUSES.deleted)))
    : [];
  const personaByAid = new Map(existingPersonas.map((p) => [p.aid, p]));
  const personaPlans = personaRows.map((row, position) => {
    const name = String(row.name ?? "");
    const description = String(row.description ?? "");
    requiredText(errors, "推奨ペルソナ: 名前", name, 50);
    optionalText(errors, "推奨ペルソナ: 説明", description, 2000);
    return { existing: personaByAid.get(String(row.aid ?? "")) ?? null, name, description, position };
  });

  // --- 設定集 ---------------------------------------------------------------
  // 自分のものは非公開でも付けられる。他人のものは公開かつアタッチ許可のものだけ
  const loreAids = [...new Set(loreRows.map((row) => String(row.lore_aid ?? "")))];
  const attachedLores = current
    ? await db.select({ lore: lores }).from(plotLores).innerJoin(lores, eq(lores.id, plotLores.loreId)).where(eq(plotLores.plotId, current.id))
    : [];
  const attachedIds = new Set(attachedLores.map((row) => row.lore.id));
  const loreCandidates = await inChunks(loreAids, (chunk) =>
    db.select().from(lores).where(and(inArray(lores.aid, chunk), ne(lores.status, CONTENT_STATUSES.deleted))));
  const loreByAid = new Map(loreCandidates.map((l) => [l.aid, l]));
  const keptLoreIds: number[] = [];
  for (const aid of loreAids) {
    const lore = loreByAid.get(aid) ?? attachedLores.find((row) => row.lore.aid === aid)?.lore;
    if (!lore) {
      errors.add("設定集が見つかりませんでした");
      break;
    }
    const own = lore.authorId !== null && lore.authorId === account.id;
    const open = lore.status === CONTENT_STATUSES.normal && lore.visibility === VISIBILITIES.opened && lore.allowAttach;
    if (!attachedIds.has(lore.id) && !own && !open) {
      errors.add(`「${lore.title}」は他の人のプロットに付けられません`);
      break;
    }
    keptLoreIds.push(lore.id);
  }

  // --- 画像 -----------------------------------------------------------------
  const owned = current ? await plotImagesOf(db, current.id) : [];
  const ownedAids = owned.length === 0 ? [] : await db.select({ id: images.id, aid: images.aid }).from(images).where(inArray(images.id, owned.map((o) => o.imageId)));
  const aidOf = new Map(ownedAids.map((r) => [r.id, r.aid]));
  const imagePlans = planImages(errors, imageRows, owned.flatMap((o) => (aidOf.has(o.imageId) ? [{ ...o, aid: aidOf.get(o.imageId)! }] : [])), form.files("images_files"));
  if (errors.any) return { ok: false, message: errors.toSentence() };

  const media = { media: c.env.MEDIA, process: c.var.imageProcessor };
  const iconFile = form.files("icon_file")[0];
  let icon;
  let uploads;
  try {
    icon = iconFile && iconFile.type.startsWith("image/") ? await storeImage(media, iconFile, "amis-plot", account.id) : null;
    uploads = await Promise.all(imagePlans.map(async (plan) =>
      plan.kind === "upload" ? { ...plan, stored: await storeImage(media, plan.file, "amis-plot", account.id) } : { ...plan, stored: null }));
  } catch (error) {
    if (error instanceof ImageInvalid) return { ok: false, message: `画像: ${error.message}` };
    throw error;
  }

  // --- 導入 -----------------------------------------------------------------
  // 新規アップロードは保存するまで aid が無いので、挿絵は画像の添字で受け取り、ここで aid に引き直す。
  // 顔は喋る本人が持っている絵だけを認める (他人のキャラの絵を指名されても通さない)
  const castImageRows = await inChunks(cast.map((p) => p.character.id), (chunk) =>
    db.select({ characterId: characterImages.characterId, aid: images.aid }).from(characterImages)
      .innerJoin(images, eq(images.id, characterImages.imageId)).where(inArray(characterImages.characterId, chunk)));
  const opening = openingRows.flatMap((line) => {
    const text = String(line.text ?? "");
    if (isBlank(rubyStrip(text))) return [];
    const plan = cast.find((p) => p.character.aid === String(line.character_aid ?? ""));
    const entry: Record<string, unknown> = { speaker: plan?.speakerKey ?? null, text };
    if (plan) {
      const iconAid = String(line.icon_aid ?? "");
      if (castImageRows.some((r) => r.characterId === plan.character.id && r.aid === iconAid)) entry.icon = iconAid;
    } else if (typeof line.image_index === "number" && Number.isInteger(line.image_index) && line.image_index >= 0) {
      const image = uploads[line.image_index];
      if (image) entry.image = image.stored?.aid ?? (image as { aid: string }).aid;
    }
    return [entry];
  });
  validateOpening(errors, opening);
  if (errors.any) return { ok: false, message: errors.toSentence() };

  // --- 書き込み (1 回の batch) ----------------------------------------------
  const aid = current?.aid ?? newAid();
  const plotRef = sql`(SELECT ${plots.id} FROM ${plots} WHERE ${plots.aid} = ${aid})`;
  const imageRef = (imageAid: string) => sql`(SELECT ${images.id} FROM ${images} WHERE ${images.aid} = ${imageAid})`;
  const statements: Batch = [];

  // 画像の行は storeImage が R2 に置いたものをここで入れる
  if (icon) statements.push(db.insert(images).values(icon));
  for (const u of uploads) if (u.stored) statements.push(db.insert(images).values(u.stored));

  const plotValues = { ...values, openingScene: opening, ...(icon ? { iconId: ref<number>(imageRef(icon.aid)) } : {}) };
  statements.push(current
    ? db.update(plots).set({ ...plotValues, updatedAt: new Date() }).where(eq(plots.id, current.id))
    : db.insert(plots).values({ title: "", ...plotValues, aid, authorId: account.id }));

  const keptCastIds = cast.flatMap((p) => (p.existingId === null ? [] : [p.existingId]));
  if (current) {
    statements.push(db.delete(plotCharacters).where(and(eq(plotCharacters.plotId, current.id), keptCastIds.length > 0 ? notInArray(plotCharacters.id, keptCastIds) : undefined)));
  }
  cast.forEach((plan, position) => {
    const set = { roleName: plan.roleName, roleDescription: plan.roleDescription, isLead: plan.isLead, position };
    statements.push(plan.existingId !== null
      ? db.update(plotCharacters).set(set).where(eq(plotCharacters.id, plan.existingId))
      : db.insert(plotCharacters).values({ ...set, plotId: ref<number>(plotRef), characterId: plan.character.id, speakerKey: plan.speakerKey }));
  });

  // チャットが参照しているので、外れたペルソナはソフトデリートする
  const keptPersonaIds = personaPlans.flatMap((p) => (p.existing ? [p.existing.id] : []));
  for (const persona of existingPersonas) {
    if (!keptPersonaIds.includes(persona.id)) statements.push(db.update(personas).set({ status: CONTENT_STATUSES.deleted }).where(eq(personas.id, persona.id)));
  }
  for (const plan of personaPlans) {
    statements.push(plan.existing
      ? db.update(personas).set({ name: plan.name, description: plan.description, position: plan.position }).where(eq(personas.id, plan.existing.id))
      : db.insert(personas).values({ aid: newAid(), plotId: ref<number>(plotRef), name: plan.name, description: plan.description, position: plan.position }));
  }

  if (current) {
    statements.push(db.delete(plotLores).where(and(eq(plotLores.plotId, current.id), keptLoreIds.length > 0 ? notInArray(plotLores.loreId, keptLoreIds) : undefined)));
  }
  for (const loreId of keptLoreIds) {
    if (!attachedIds.has(loreId)) statements.push(db.insert(plotLores).values({ plotId: ref<number>(plotRef), loreId }).onConflictDoNothing());
  }

  const keptImageIds = uploads.flatMap((u) => (u.kind === "existing" ? [u.imageId] : []));
  if (current) {
    statements.push(db.delete(plotImages).where(and(eq(plotImages.plotId, current.id), keptImageIds.length > 0 ? notInArray(plotImages.imageId, keptImageIds) : undefined)));
  }
  uploads.forEach((u, position) => {
    statements.push(u.kind === "existing"
      ? db.update(plotImages).set({ situation: u.situation, secret: u.secret, position }).where(and(eq(plotImages.plotId, current!.id), eq(plotImages.imageId, u.imageId)))
      : db.insert(plotImages).values({ plotId: ref<number>(plotRef), imageId: ref<number>(imageRef(u.stored!.aid)), situation: u.situation, secret: u.secret, position }));
  });

  // 主役の数と、設定集が付いているプロットの数は数え直す
  const touchedCharacters = [...new Set([...existingCast.map((r) => r.character.id), ...cast.map((p) => p.character.id)])];
  for (const id of touchedCharacters) {
    statements.push(db.update(characters).set({
      leadsCount: sql`(SELECT COUNT(*) FROM ${plotCharacters} WHERE ${plotCharacters.characterId} = ${id} AND ${plotCharacters.isLead} = 1)`,
    }).where(eq(characters.id, id)));
  }
  const touchedLores = [...new Set([...attachedIds, ...keptLoreIds])];
  for (const id of touchedLores) {
    statements.push(db.update(lores).set({ plotsCount: sql`(SELECT COUNT(*) FROM ${plotLores} WHERE ${plotLores.loreId} = ${id})` }).where(eq(lores.id, id)));
  }

  await db.batch(statements as [BatchItem<"sqlite">, ...Batch]);
  return { ok: true, aid };
}

// 他人のキャラは、公開かつ出演を許可しているものだけ出せる
function castableCharacter(errors: ValidationErrors, character: Character | undefined, accountId: number): Character | null {
  if (!character) {
    errors.add("出演キャラが見つかりませんでした");
    return null;
  }
  if (character.authorId !== null && character.authorId === accountId) return character;
  if (character.status === CONTENT_STATUSES.normal && character.visibility === VISIBILITIES.opened && character.allowCasting) return character;
  errors.add(`「${character.name}」は他の人のプロットに出演させられません`);
  return null;
}

// キャラ名を小文字の英数字にしたもの。無ければ cast。使われていれば番号を付ける (本体の PlotCharacter#generate_speaker_key)
function speakerKeyFor(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 28) || "cast";
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}${suffix}`;
  used.add(candidate);
  return candidate;
}

// 本体の OpeningSceneValidator
function validateOpening(errors: ValidationErrors, lines: Record<string, unknown>[]) {
  if (lines.length > MAX_OPENING_LINES) return errors.add(`導入は${MAX_OPENING_LINES}行までです`);
  lines.forEach((line, i) => {
    if (charLength(String(line.text)) > MAX_OPENING_TEXT) errors.add(`導入[${i}] の本文は${MAX_OPENING_TEXT}文字までです`);
  });
}

// キャラ + 画像を 1 回の保存で同期する (本体の Amis::CharacterWriter とキャラのバリデーション)。
// D1 は途中で読んで判断するトランザクションを開けないので、先にすべて検証し、画像を R2 に置いてから、
// 行の書き込みを 1 回の batch にまとめる (全部入るか、全部入らないか)
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Context } from "hono";
import { characterImages, characters, images } from "../db/schema";
import type { AppEnv } from "../env";
import { newAid } from "../lib/aid";
import { ValidationErrors } from "../lib/errors";
import { readForm } from "../lib/form";
import { ImageInvalid, storeImage } from "../media/images";
import { characterImagesOf } from "../queries/related";
import type { Character } from "../views/context";
import { bool, enumValue, normalizeNewlines, optionalText, parseJsonRows, requiredText, USER_RATING_KEYS, VISIBILITY_KEYS } from "./common";
import { planImages } from "./image-sync";

export type SaveResult = { ok: true; aid: string } | { ok: false; message: string };

export async function saveCharacter(c: Context<AppEnv>, current: Character | null): Promise<SaveResult> {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const form = await readForm(c, "character");
  const errors = new ValidationErrors();

  const values: Partial<typeof characters.$inferInsert> = {};
  for (const [key, column] of [["name", "name"], ["tagline", "tagline"]] as const) {
    if (form.has(key)) values[column] = form.get(key) ?? "";
  }
  if (form.has("description")) values.description = normalizeNewlines(form.get("description") ?? "");
  if (form.has("persona")) values.persona = normalizeNewlines(form.get("persona") ?? "");
  if (form.has("persona_public")) values.personaPublic = bool(form.get("persona_public"));
  if (form.has("allow_casting")) values.allowCasting = bool(form.get("allow_casting"));
  if (form.has("allow_fork")) values.allowFork = bool(form.get("allow_fork"));
  if (form.has("visibility")) values.visibility = enumValue(errors, "公開状態", VISIBILITY_KEYS, form.get("visibility"));
  if (form.has("user_rating")) values.userRating = enumValue(errors, "レーティング", USER_RATING_KEYS, form.get("user_rating"));

  requiredText(errors, "名前", values.name ?? current?.name ?? "", 50);
  optionalText(errors, "一言紹介", values.tagline ?? current?.tagline ?? "", 100);
  optionalText(errors, "公開プロフ文", values.description ?? current?.description ?? "", 2000);
  // 定義は毎ターン system プロンプトに載る。出演 10 人ぶんが毎回再送されるので、1 人あたりの長さがそのまま原価になる
  requiredText(errors, "定義", values.persona ?? current?.persona ?? "", 10000);

  const owned = current ? ((await characterImagesOf(db, [current.id])).get(current.id) ?? []) : [];
  const ownedAids = owned.length === 0 ? [] : await db.select({ id: images.id, aid: images.aid }).from(images)
    .where(inArray(images.id, owned.map((o) => o.imageId)));
  const aidOf = new Map(ownedAids.map((r) => [r.id, r.aid]));
  const rows = parseJsonRows(errors, "画像", form.get("images_json"));
  const plans = rows === null ? null : planImages(errors, rows, owned.flatMap((o) => (aidOf.has(o.imageId) ? [{ ...o, aid: aidOf.get(o.imageId)! }] : [])), form.files("images_files"));
  if (errors.any) return { ok: false, message: errors.toSentence() };

  // 画像を変換して R2 に置く。行は下の batch で入れる
  const media = { media: c.env.MEDIA, process: c.var.imageProcessor };
  const iconFile = form.files("icon_file")[0];
  let icon;
  let uploads;
  try {
    icon = iconFile && iconFile.type.startsWith("image/") ? await storeImage(media, iconFile, "amis-character", account.id) : null;
    uploads = await Promise.all((plans ?? []).map(async (plan) =>
      plan.kind === "upload" ? { ...plan, stored: await storeImage(media, plan.file, "amis-character", account.id) } : { ...plan, stored: null }));
  } catch (error) {
    if (error instanceof ImageInvalid) return { ok: false, message: `画像: ${error.message}` };
    throw error;
  }

  const aid = current?.aid ?? newAid();
  const characterRef = sql`(SELECT ${characters.id} FROM ${characters} WHERE ${characters.aid} = ${aid})`;
  const imageRef = (imageAid: string) => sql`(SELECT ${images.id} FROM ${images} WHERE ${images.aid} = ${imageAid})`;
  const statements: BatchItem<"sqlite">[] = [
    ...(icon ? [db.insert(images).values(icon)] : []),
    ...uploads.filter((u) => u.stored).map((u) => db.insert(images).values(u.stored!)),
    current
      ? db.update(characters).set({ ...values, ...(icon ? { iconId: imageRef(icon.aid) as unknown as number } : {}), updatedAt: new Date() })
        .where(eq(characters.id, current.id))
      : db.insert(characters).values({
        name: "", persona: "", ...values, aid, authorId: account.id,
        ...(icon ? { iconId: imageRef(icon.aid) as unknown as number } : {}),
      }),
  ];
  if (plans !== null) {
    const keptIds = uploads.filter((u) => u.kind === "existing").map((u) => (u as { imageId: number }).imageId);
    if (current) {
      statements.push(db.delete(characterImages).where(and(
        eq(characterImages.characterId, current.id),
        keptIds.length > 0 ? notInArray(characterImages.imageId, keptIds) : undefined,
      )));
    }
    uploads.forEach((u, position) => {
      statements.push(u.kind === "existing"
        ? db.update(characterImages).set({ situation: u.situation, secret: u.secret, position })
          .where(and(eq(characterImages.characterId, current!.id), eq(characterImages.imageId, u.imageId)))
        : db.insert(characterImages).values({
          characterId: characterRef as unknown as number, imageId: imageRef(u.stored!.aid) as unknown as number,
          situation: u.situation, secret: u.secret, position,
        }));
    });
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { ok: true, aid };
}

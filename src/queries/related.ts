// 一覧や編集画面で、行ごとに付いてくるものをまとめて引く
import { asc, eq, inArray, sql } from "drizzle-orm";
import { type Db, inChunks } from "../db/client";
import { characterImages, loreEntries, plotImages } from "../db/schema";
import type { OwnedImage } from "../views/json";

type OwnedImageRow = OwnedImage & { ownerId: number; position: number; id: number };

function groupByOwner(rows: OwnedImageRow[]): Map<number, OwnedImage[]> {
  rows.sort((a, b) => a.position - b.position || a.id - b.id);
  const grouped = new Map<number, OwnedImage[]>();
  for (const { ownerId, imageId, situation, secret } of rows) {
    grouped.set(ownerId, [...(grouped.get(ownerId) ?? []), { imageId, situation, secret }]);
  }
  return grouped;
}

// キャラの追加画像 (表情差分など)。シークレットも含めて position, id の順
export async function characterImagesOf(db: Db, characterIds: number[]): Promise<Map<number, OwnedImage[]>> {
  const rows = await inChunks(characterIds, (ids) =>
    db.select({
      ownerId: characterImages.characterId, imageId: characterImages.imageId, situation: characterImages.situation,
      secret: characterImages.secret, position: characterImages.position, id: characterImages.id,
    }).from(characterImages).where(inArray(characterImages.characterId, ids)));
  return groupByOwner(rows);
}

export async function plotImagesOf(db: Db, plotId: number): Promise<OwnedImage[]> {
  const rows = await db.select({
    ownerId: plotImages.plotId, imageId: plotImages.imageId, situation: plotImages.situation,
    secret: plotImages.secret, position: plotImages.position, id: plotImages.id,
  }).from(plotImages).where(eq(plotImages.plotId, plotId));
  return groupByOwner(rows).get(plotId) ?? [];
}

export const imageIdsOf = (owned: Iterable<OwnedImage[]>) => [...owned].flat().map((o) => o.imageId);

// 全項目が同時に発火したときの本文の合計 (文字数)。1 ターンに載りうる最大の分量にあたる
export async function loreBodyLengths(db: Db, loreIds: number[]): Promise<Map<number, number>> {
  const rows = await inChunks(loreIds, (ids) =>
    db.select({ loreId: loreEntries.loreId, length: sql<number>`sum(length(${loreEntries.body}))` })
      .from(loreEntries).where(inArray(loreEntries.loreId, ids)).groupBy(loreEntries.loreId));
  return new Map(rows.map((r) => [r.loreId, Number(r.length)]));
}

export async function entriesOf(db: Db, loreIds: number[]) {
  const rows = await inChunks(loreIds, (ids) =>
    db.select().from(loreEntries).where(inArray(loreEntries.loreId, ids)).orderBy(asc(loreEntries.id)));
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) grouped.set(row.loreId, [...(grouped.get(row.loreId) ?? []), row]);
  return grouped;
}

// 本体の sanitize_sql_like と同じく、% と _ と \ を文字として扱う
export function containing(column: Parameters<typeof sql>[1], query: string) {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return sql`${column} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
}

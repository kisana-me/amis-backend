// 一覧や詳細の JSON に要るものを、1 リクエストの中でまとめて引く。
// 本体の includes(:icon, author: :icon, plot_characters: { character: :icon }) に当たる
import { inArray } from "drizzle-orm";
import { type Account, findAccountsByIds } from "../accounts/accounts";
import { type Db, inChunks } from "../db/client";
import { characters, images, plotCharacters, type plots } from "../db/schema";
import type { MainDb } from "../lib/main-db";
import { maxRatingFor, type Viewer } from "../lib/ratings";
import type { UrlEnv } from "../lib/urls";

export type Character = typeof characters.$inferSelect;
export type Plot = typeof plots.$inferSelect;
export type Image = typeof images.$inferSelect;
export type PlotCharacter = typeof plotCharacters.$inferSelect;
export type Cast = { plotCharacter: PlotCharacter; character: Character };

export type ViewContext = {
  env: UrlEnv;
  // 見ている人に見せてよいレーティングの上限 (本体の amis_max_rating)
  maxRating: number;
  images: Map<number, Image>;
  authors: Map<number, Account>;
  // プロットの出演者。position, id の順 (本体の plot_characters の並び)
  casts: Map<number, Cast[]>;
};

export type Loaders = { db: Db; mainDb: MainDb; env: UrlEnv; viewer: Viewer };

export async function loadContext(
  { db, mainDb, env, viewer }: Loaders,
  input: { plots?: Plot[]; characters?: Character[]; imageIds?: number[] },
): Promise<ViewContext> {
  const plotList = input.plots ?? [];
  const casts = await loadCasts(db, plotList);
  const characterList = [...(input.characters ?? []), ...[...casts.values()].flat().map((c) => c.character)];

  const imageIds = [
    ...plotList.map((p) => p.iconId),
    ...characterList.map((c) => c.iconId),
    ...(input.imageIds ?? []),
  ].filter((id): id is number => id !== null);
  const authorIds = [...plotList.map((p) => p.authorId), ...characterList.map((c) => c.authorId)]
    .filter((id): id is number => id !== null);

  const [imageRows, authors] = await Promise.all([
    inChunks(imageIds, (ids) => db.select().from(images).where(inArray(images.id, ids))),
    findAccountsByIds(mainDb, env, authorIds),
  ]);

  return {
    env,
    maxRating: maxRatingFor(viewer),
    images: new Map(imageRows.map((image) => [image.id, image])),
    authors,
    casts,
  };
}

// 出演者は、キャラの状態に関わらずすべて返す (本体の plot.plot_characters と同じ)
async function loadCasts(db: Db, plotList: Plot[]): Promise<Map<number, Cast[]>> {
  const casts = new Map<number, Cast[]>();
  if (plotList.length === 0) return casts;

  const rows = await inChunks(plotList.map((p) => p.id), (ids) =>
    db.select().from(plotCharacters).where(inArray(plotCharacters.plotId, ids)));
  const characterRows = await inChunks(rows.map((r) => r.characterId), (ids) =>
    db.select().from(characters).where(inArray(characters.id, ids)));
  const byId = new Map(characterRows.map((c) => [c.id, c]));

  rows.sort((a, b) => a.position - b.position || a.id - b.id);
  for (const plotCharacter of rows) {
    const character = byId.get(plotCharacter.characterId);
    if (!character) continue;
    const list = casts.get(plotCharacter.plotId) ?? [];
    list.push({ plotCharacter, character });
    casts.set(plotCharacter.plotId, list);
  }
  return casts;
}

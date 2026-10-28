// 本文の編集で選べる絵 (本体の Chat#palette_for) と、その元になる絵の並び
import { asc, eq, inArray } from "drizzle-orm";
import { type Db, inChunks } from "../db/client";
import { CONTENT_STATUSES, characterImages, plotImages } from "../db/schema";
import { isBlank } from "../generation/ruby-text";
import { type Loaders, loadCasts, loadContext, type Plot } from "./context";
import { imageUrl } from "./json";

export type SceneImageRow = { kind: "plot" | "character"; characterId: number | null; imageId: number; situation: string; secret: boolean };

// プロットの絵 (position, id 順) → 出演者の絵 (出演順、各キャラの position, id 順)
export async function sceneImageCandidates(db: Db, plot: Plot): Promise<SceneImageRow[]> {
  const [plotRows, casts] = await Promise.all([
    db.select().from(plotImages).where(eq(plotImages.plotId, plot.id)).orderBy(asc(plotImages.position), asc(plotImages.id)),
    loadCasts(db, [plot]),
  ]);
  const characterIds = (casts.get(plot.id) ?? []).map((cast) => cast.character.id);
  const characterRows = characterIds.length === 0 ? [] : await inChunks(characterIds, (chunk) =>
    db.select().from(characterImages).where(inArray(characterImages.characterId, chunk)));
  characterRows.sort((a, b) => a.position - b.position || a.id - b.id);

  return [
    ...plotRows.map((r) => ({ kind: "plot" as const, characterId: null, imageId: r.imageId, situation: r.situation, secret: r.secret })),
    ...characterIds.flatMap((id) => characterRows.filter((r) => r.characterId === id)
      .map((r) => ({ kind: "character" as const, characterId: id, imageId: r.imageId, situation: r.situation, secret: r.secret }))),
  ];
}

export type PaletteEntry = { aid: string; url: string; situation: string; secret: boolean };
export type Palette = { plot_images: PaletteEntry[]; characters: Record<string, PaletteEntry[]> };

// 作者が伏せた絵 (secret) と、見る人のレーティングでは見られない絵は候補に出さない。
// AI は伏せた絵も使えるが、人が選ぶ場所には出さない。ただし keep に渡した aid は例外
// (AI が伏せた絵で書いた返答を編集するとき、候補に無いと選び直せないうえ保存もできなくなる)
export async function paletteFor(loaders: Loaders, plot: Plot, keep: Set<string> = new Set()): Promise<Palette> {
  const rows = await sceneImageCandidates(loaders.db, plot);
  const ctx = await loadContext(loaders, { imageIds: rows.map((r) => r.imageId) });

  // ラベルの無い絵は scene_images に載らない = 選んでも表示できないので候補にしない
  const entry = (row: SceneImageRow): PaletteEntry[] => {
    const image = ctx.images.get(row.imageId);
    if (row.secret && !(image && keep.has(image.aid))) return [];
    if (isBlank(row.situation) || !image || image.status !== CONTENT_STATUSES.normal || (image.rating ?? 0) > ctx.maxRating) return [];
    return [{ aid: image.aid, url: imageUrl(image, ctx), situation: row.situation, secret: row.secret }];
  };
  const casts = (await loadCasts(loaders.db, [plot])).get(plot.id) ?? [];
  return {
    plot_images: rows.filter((r) => r.kind === "plot").flatMap(entry),
    characters: Object.fromEntries(casts.map(({ plotCharacter, character }) => [
      plotCharacter.speakerKey,
      rows.filter((r) => r.kind === "character" && r.characterId === character.id).flatMap(entry),
    ])),
  };
}

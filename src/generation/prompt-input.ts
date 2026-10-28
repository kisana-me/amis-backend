// PromptBuilder に渡すものを D1 からまとめて読み込む
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { inChunks } from "../db/client";
import { chatMessages, images, MESSAGE_STATUSES, personas, plotLores } from "../db/schema";
import { characterImagesOf, plotImagesOf } from "../queries/related";
import type { OwnedImage } from "../views/json";
import { type Chat, type ChatMessage, loadCasts, type Plot } from "../views/context";
import type { LabeledImage, PromptInput } from "./prompt-builder";
import { isPresent } from "./ruby-text";

type Extra = Pick<PromptInput, "rejected" | "instruction" | "autoContinue" | "loreBlock">;

export async function loadPromptInput(db: Db, chat: Chat, plot: Plot, ownerName: string, extra: Extra = {}): Promise<PromptInput> {
  const casts = (await loadCasts(db, [plot])).get(plot.id) ?? [];
  const [owned, plotOwned, [lore], [persona], messages] = await Promise.all([
    characterImagesOf(db, casts.map((c) => c.character.id)),
    plotImagesOf(db, plot.id),
    db.select({ plotId: plotLores.plotId }).from(plotLores).where(eq(plotLores.plotId, plot.id)).limit(1),
    chat.personaId === null ? Promise.resolve([]) : db.select().from(personas).where(eq(personas.id, chat.personaId)).limit(1),
    promptMessages(db, chat),
  ]);

  // 場面の説明 (situation) が入っていて、画像が実在するものだけが候補になる
  const imageRows = await inChunks([...[...owned.values()].flat(), ...plotOwned].map((o) => o.imageId), (ids) =>
    db.select({ id: images.id, aid: images.aid }).from(images).where(inArray(images.id, ids)));
  const aidById = new Map(imageRows.map((r) => [r.id, r.aid]));
  const labeled = (rows: OwnedImage[]): LabeledImage[] =>
    rows.flatMap((row) => (isPresent(row.situation) && aidById.has(row.imageId) ? [{ aid: aidById.get(row.imageId)!, situation: row.situation }] : []));

  return {
    chat: {
      aid: chat.aid,
      currentChapterKey: chat.currentChapterKey,
      turnsInChapter: chat.turnsInChapter,
      choiceMode: chat.choiceMode,
      replyStyle: chat.replyStyle,
      finished: chat.finishedAt !== null,
      summaries: chat.summaries,
    },
    plot: { situation: plot.situation, chapters: plot.chapters },
    casts: casts.map(({ plotCharacter, character }) => ({
      speakerKey: plotCharacter.speakerKey,
      roleName: plotCharacter.roleName,
      roleDescription: plotCharacter.roleDescription,
      name: character.name,
      persona: character.persona,
      images: labeled(owned.get(character.id) ?? []),
    })),
    plotImages: labeled(plotOwned),
    hasLores: lore !== undefined,
    persona: persona ? { name: persona.name, description: persona.description } : null,
    ownerName,
    messages,
    ...extra,
  };
}

// プロンプトに載せる会話。いまの章の、要約に畳んだ分より後ろの normal だけ (本体の Chat#prompt_messages)
export async function promptMessages(db: Db, chat: Chat): Promise<ChatMessage[]> {
  return db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.chatId, chat.id),
      eq(chatMessages.chapterKey, chat.currentChapterKey),
      gt(chatMessages.id, summarizedUptoId(chat)),
      eq(chatMessages.status, MESSAGE_STATUSES.normal),
    ))
    .orderBy(asc(chatMessages.id));
}

export function summarizedUptoId(chat: Chat): number {
  return Math.trunc(Number(chat.meta.summarized_upto_id) || 0);
}

// 直近の会話に現れたキーワードから、そのターンだけ差し込む設定を選ぶ (本体の Amis::LoreMatcher)。
// 同じ入力からは必ず同じブロックが出る。system プロンプトではなく会話の末尾に置くので、
// ここが毎ターン変わってもプレフィックスキャッシュは壊れない
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { CONTENT_STATUSES, chatMessages, loreEntries, lores, MESSAGE_STATUSES, plotLores } from "../db/schema";
import { scene } from "../views/chat";
import type { LoreEntry } from "../views/context";
import { isBlank, isPresent, rubyStrip } from "./ruby-text";

// 走査する往復の数。長いと原価、短いと設定が抜け落ちる
const TURNS = 3;
const WINDOW = TURNS * 2;
const HEADING = "【設定】";
const KEYWORD_SEPARATOR = /[、,]+/;

export type LoreHit = { entry: LoreEntry; keyword: string };

export function keywordList(keywords: string): string[] {
  return [...new Set(keywords.split(KEYWORD_SEPARATOR).map(rubyStrip).filter((w) => isPresent(w)))];
}

// 全角と半角、大文字と小文字の揺れは吸収する
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

// entries は (lore_id, id) の順。当たったものを同じ順で返す。ラベルはキーワード列の先頭で当たったもの
export function matchLore(entries: LoreEntry[], windowText: string): LoreHit[] {
  if (entries.length === 0) return [];
  const haystack = normalize(windowText);
  if (isBlank(haystack)) return [];

  return entries.flatMap((entry) => {
    const keyword = keywordList(entry.keywords).find((word) => haystack.includes(normalize(word)));
    return keyword ? [{ entry, keyword }] : [];
  });
}

// 会話の末尾に足す user メッセージ。当たったキーワードだけをラベルにし、項目タイトルは載せない
export function loreBlock(hits: LoreHit[]): string | null {
  if (hits.length === 0) return null;
  return [HEADING, ...hits.map((hit) => `【${hit.keyword}】${rubyStrip(hit.entry.body)}`)].join("\n");
}

// プロットに付いている設定集 (削除されていないもの) の項目を、(lore_id, id) の順で
export async function loreEntriesFor(db: Db, plotId: number): Promise<LoreEntry[]> {
  return db.select({ entry: loreEntries }).from(loreEntries)
    .innerJoin(lores, eq(lores.id, loreEntries.loreId))
    .innerJoin(plotLores, and(eq(plotLores.loreId, lores.id), eq(plotLores.plotId, plotId)))
    .where(eq(lores.status, CONTENT_STATUSES.normal))
    .orderBy(asc(loreEntries.loreId), asc(loreEntries.id))
    .then((rows) => rows.map((r) => r.entry));
}

// プロンプトに載る会話ではなく、表示されている会話の末尾から取る。
// プロンプトに載る会話は章と要約で切れているので、章が変わった瞬間に全部の設定が一斉に落ちてしまう
export async function loreWindowText(db: Db, chatId: number, excludeIds: number[] = []): Promise<string> {
  const rows = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.chatId, chatId),
      eq(chatMessages.status, MESSAGE_STATUSES.normal),
      excludeIds.length > 0 ? notInArray(chatMessages.id, excludeIds) : undefined,
    ))
    .orderBy(desc(chatMessages.id)).limit(WINDOW);
  return rows.flatMap((m) => scene(m).map((line) => line.text)).join("\n");
}

export async function loreHitsFor(db: Db, chat: { id: number; plotId: number }, excludeIds: number[] = []): Promise<LoreHit[]> {
  const entries = await loreEntriesFor(db, chat.plotId);
  if (entries.length === 0) return [];
  return matchLore(entries, await loreWindowText(db, chat.id, excludeIds));
}


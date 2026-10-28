// 「これまでの会話 + 今回のぶん」を丸ごと返してくるモデルがあるので、
// 履歴にすでにある行が先頭から続いている間は落とし、今回のぶんだけを残す (本体の Amis::ReplayTrimmer)
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages, MESSAGE_STATUSES } from "../db/schema";
import { scene } from "../views/chat";
import type { SceneEntry } from "./scene-presenter";

const LOOKBACK = 60;
// 焼き直しは書き直したものなので末尾までは一致しない。行頭だけで突き合わせる
const KEY_LENGTH = 25;

export function keyFor(text: string): string {
  return Array.from(String(text ?? "").replace(/\s/gu, "")).slice(0, KEY_LENGTH).join("");
}

export function trim(lines: SceneEntry[], known: Set<string>): SceneEntry[] {
  if (lines.length < 2 || known.size === 0) return lines;
  const start = lines.findIndex((line) => !known.has(keyFor(line.text)));
  // 全部が既出なら、今回のぶんがどこからか判断できない。触らずに残す
  return start < 0 ? lines : lines.slice(start);
}

// before_id より前の、表示されている normal の返答の直近 60 件。
// (本体は関連の order(:id) に order(id: :desc) を足しているため、実際には古い方から 60 件を取っている。
// 会話が 60 件を超えるまでは同じ結果なので、ここでは意図どおり直近から取る)
export async function knownTexts(db: Db, chatId: number, beforeId: number): Promise<Set<string>> {
  const rows = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), eq(chatMessages.status, MESSAGE_STATUSES.normal), lt(chatMessages.id, beforeId)))
    .orderBy(desc(chatMessages.id)).limit(LOOKBACK);
  return new Set(rows.flatMap((m) => scene(m).map((line) => keyFor(line.text))));
}

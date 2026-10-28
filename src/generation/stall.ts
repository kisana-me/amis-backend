// 止まってしまった生成を見つけて失敗に倒す (本体の SweepStalledMessagesJob)。
// 生成は SSE のリクエストの中で動くので、クライアントが切断してから 30 秒を超えると打ち切られる。
// そうなったものは streamed_at が進まなくなるので、それを見て判断する
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages, MESSAGE_STATUSES } from "../db/schema";
import type { ChatMessage } from "../views/context";

// 生成中は 1 秒ごとに streamed_at を進めているので、30 秒動かなければ止まっている
const STREAMING_STALL_MS = 30_000;
// 送信したのに誰も SSE をつながなかった (生成が始まらなかった) もの
const PENDING_STALL_MS = 60_000;

export const IN_FLIGHT = [MESSAGE_STATUSES.pending, MESSAGE_STATUSES.streaming];

export function isStalled(message: ChatMessage, now = Date.now()): boolean {
  if (message.status === MESSAGE_STATUSES.streaming) {
    return now - (message.streamedAt ?? message.createdAt).getTime() > STREAMING_STALL_MS;
  }
  if (message.status === MESSAGE_STATUSES.pending) return now - message.createdAt.getTime() > PENDING_STALL_MS;
  return false;
}

// 失敗に倒せたら true。その間に生成が進んでいた (状態が変わっていた) ら何もしない
export async function sweepStalled(db: Db, message: ChatMessage): Promise<boolean> {
  const result = await db.update(chatMessages)
    .set({ status: MESSAGE_STATUSES.failed, streamedAt: new Date(), meta: { ...message.meta, error: "stalled", swept_at: new Date().toISOString() } })
    .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, message.status), inArray(chatMessages.status, IN_FLIGHT)))
    .run();
  return result.meta.changes > 0;
}

// チャットの生成中のメッセージ。止まっているものは失敗に倒してから判断する
export async function pendingMessage(db: Db, chatId: number): Promise<ChatMessage | null> {
  const rows = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), inArray(chatMessages.status, IN_FLIGHT)));
  let latest: ChatMessage | null = null;
  for (const message of rows) {
    if (isStalled(message) && (await sweepStalled(db, message))) continue;
    if (!latest || latest.id < message.id) latest = message;
  }
  return latest;
}

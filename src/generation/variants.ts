// やり直しでできた兄弟 (本体の ChatMessage#variants)。
// replaced_by_id を「次に生成した 1 本」へのリンクとして辿る。リンクは新しい id にしか向かないので輪にはならない
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages } from "../db/schema";
import type { ChatMessage } from "../views/context";

export function variantChain(message: ChatMessage, all: ChatMessage[]): ChatMessage[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  const previousOf = new Map(all.filter((m) => m.replacedById !== null).map((m) => [m.replacedById!, m]));
  let root = message;
  for (let prev = previousOf.get(root.id); prev; prev = previousOf.get(root.id)) root = prev;

  const list = [root];
  for (let next = root.replacedById; next !== null;) {
    const found = byId.get(next);
    if (!found) break;
    list.push(found);
    next = found.replacedById;
  }
  return list;
}

export async function variantsOf(db: Db, message: ChatMessage): Promise<ChatMessage[]> {
  const all = await db.select().from(chatMessages).where(eq(chatMessages.chatId, message.chatId));
  return variantChain(message, all);
}

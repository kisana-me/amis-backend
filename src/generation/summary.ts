// 章が閉じるたびに要約を追記し、以降のプロンプトでは生の会話ではなくこれを渡す (本体の Amis::ChapterSummaryJob)。
// 章の無い自由なチャットでは、同じ処理をローリング要約として使う。
// 生成のリクエストの中で、done を送ったあとに waitUntil で走らせる
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiUsages, chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, personas, plots } from "../db/schema";
import type { Bindings } from "../env";
import { scene } from "../views/chat";
import { loadCasts } from "../views/context";
import { streamCompletion } from "./ai-client";
import { costMicro, findModelById, usableModel } from "./models";
import summarySystem from "./prompts/summary-system.txt";
import { summarizedUptoId } from "./prompt-input";
import { isPresent, rubyStrip } from "./ruby-text";

const MAX_SOURCE_MESSAGES = 200;
// ローリング要約で、畳まずに生のまま残す末尾のメッセージの数
const ROLLING_KEEP_MESSAGES = 24;

export type SummaryMode = "chapter" | "rolling";

export async function summarize(deps: { db: Db; env: Bindings; ownerName: string }, chatId: number, chapterKey: string | null, mode: SummaryMode) {
  const { db, env } = deps;
  try {
    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!chat) return;

    const { messages, uptoId } = await sourceMessages(db, chat, chapterKey, mode);
    if (messages.length === 0) return;

    const model = await usableModel(db, 0, await findModelById(db, chat.aiModelId));
    if (!model) return;

    const [[plot], [persona]] = await Promise.all([
      db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1),
      chat.personaId === null ? Promise.resolve([]) : db.select().from(personas).where(eq(personas.id, chat.personaId)).limit(1),
    ]);
    const names = new Map(((await loadCasts(db, [plot])).get(plot.id) ?? []).map((c) => [c.plotCharacter.speakerKey, c.character.name]));
    const userName = isPresent(persona?.name) ? persona!.name : deps.ownerName;

    const transcript = messages.map((message) =>
      message.role === MESSAGE_ROLES.user
        ? `${userName}: ${scene(message).map((line) => line.text).join("\n")}`
        : scene(message).map((line) => `${isPresent(line.speaker) ? (names.get(String(line.speaker)) ?? line.speaker) : "地の文"}: ${line.text}`).join("\n"),
    ).join("\n");

    let raw = "";
    const result = await streamCompletion(model, [
      { role: "system", content: summarySystem },
      { role: "user", content: transcript },
    ], { mode: "summary" }, env, (delta) => {
      raw += delta;
    });
    await db.insert(aiUsages).values({
      accountId: chat.accountId, aiModelId: model.id, chatId: chat.id, purpose: 1,
      promptTokens: result.promptTokens, cachedTokens: result.cachedTokens, completionTokens: result.completionTokens,
      reasoningTokens: result.reasoningTokens, costMicro: costMicro(model, result), gatewayLogId: result.gatewayLogId,
      finishReason: result.finishReason,
    });

    const text = extract(raw);
    if (!text) return;
    // 読んでから書くと、そのあいだの書き込みを潰しうる。追記はその場で SQL に任せる
    const entry = JSON.stringify({ chapter_key: chapterKey ?? "", text });
    await db.update(chats).set({
      summaries: sql`json_insert(${chats.summaries}, '$[#]', json(${entry}))`,
      ...(mode === "rolling" && uptoId !== null ? { meta: sql`json_set(${chats.meta}, '$.summarized_upto_id', ${uptoId})` } : {}),
    }).where(eq(chats.id, chat.id));
  } catch (error) {
    console.error("chapter summary failed", error);
  }
}

async function sourceMessages(db: Db, chat: typeof chats.$inferSelect, chapterKey: string | null, mode: SummaryMode) {
  if (mode === "rolling") {
    const all = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.status, MESSAGE_STATUSES.normal), gt(chatMessages.id, summarizedUptoId(chat))))
      .orderBy(asc(chatMessages.id));
    if (all.length <= ROLLING_KEEP_MESSAGES) return { messages: [], uptoId: null };
    const folded = all.slice(0, all.length - ROLLING_KEEP_MESSAGES);
    return { messages: folded.slice(-MAX_SOURCE_MESSAGES), uptoId: folded.at(-1)!.id };
  }
  const messages = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.status, MESSAGE_STATUSES.normal), eq(chatMessages.chapterKey, chapterKey ?? "")))
    .orderBy(asc(chatMessages.id));
  return { messages: messages.slice(-MAX_SOURCE_MESSAGES), uptoId: null };
}

// JSON で返してくる上流がまだ残っていても拾えるようにしておく
function extract(raw: string): string | null {
  const text = rubyStrip(raw);
  if (!text.startsWith("{")) return isPresent(text) ? text : null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const summary = rubyStrip(String(parsed.summary ?? ""));
      return isPresent(summary) ? summary : null;
    }
  } catch {
    // JSON でなければそのまま使う
  }
  return isPresent(text) ? text : null;
}

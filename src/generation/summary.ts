// 会話が伸びたら古いぶんを要約に畳んで追記し、以降のプロンプトでは生の会話ではなくこれを渡す (ローリング要約)。
// 要約が溜まりすぎたら、新しいいくつかを残して古いものを 1 本にまとめ直す (要約の要約)。
// 生成のリクエストの中で、done を送ったあとに waitUntil で走らせる
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiUsages, chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, personas, plots } from "../db/schema";
import type { Bindings } from "../env";
import { scene } from "../views/chat";
import { type AiModel, loadCasts } from "../views/context";
import { streamCompletion } from "./ai-client";
import { costMicro, findModelById, usableModel } from "./models";
import summaryMerge from "./prompts/summary-merge.txt";
import summarySystem from "./prompts/summary-system.txt";
import { summarizedUptoId } from "./prompt-input";
import { isPresent, rubyStrip } from "./ruby-text";

const MAX_SOURCE_MESSAGES = 200;
// 畳まずに生のまま残す末尾のメッセージの数
const ROLLING_KEEP_MESSAGES = 30;
// 要約がこの本数を超えたら、新しい側の KEEP_RECENT_SUMMARIES 本を残して古いものを 1 本にまとめる
const MAX_SUMMARIES = 6;
const KEEP_RECENT_SUMMARIES = 3;
// 同じチャットの要約は 1 本ずつ走らせる。落ちた実行が握ったままにならないよう、期限を切る
const LEASE_MS = 5 * 60_000;

type Deps = { db: Db; env: Bindings; ownerName: string };

export async function summarize(deps: Deps, chatId: number) {
  const { db } = deps;
  const startedAt = Date.now();
  // 取れなければ、いま走っている側に任せる。上流を呼ぶ前に弾くので、二重に原価もかからない
  const claimed = await db.update(chats)
    .set({ meta: sql`json_set(${chats.meta}, '$.summary_started_at', ${startedAt})` })
    .where(and(eq(chats.id, chatId), sql`coalesce(json_extract(${chats.meta}, '$.summary_started_at'), 0) < ${startedAt - LEASE_MS}`))
    .run();
  if (claimed.meta.changes === 0) return;

  try {
    await fold(deps, chatId);
  } catch (error) {
    console.error("summary failed", error);
  } finally {
    // 期限切れで別の実行に取られていたら、そちらのものなので触らない
    await db.update(chats)
      .set({ meta: sql`json_remove(${chats.meta}, '$.summary_started_at')` })
      .where(and(eq(chats.id, chatId), sql`json_extract(${chats.meta}, '$.summary_started_at') = ${startedAt}`))
      .run()
      .catch((error) => console.error("summary lease release failed", error));
  }
}

async function fold(deps: Deps, chatId: number) {
  const { db } = deps;
  // リースを取ってから読む。直前に終わった実行が進めた位置から続ける
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) return;
  const fromId = summarizedUptoId(chat);

  const { messages, uptoId } = await sourceMessages(db, chat);
  if (uptoId === null) return;

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

  const text = await complete(deps, chat, model, summarySystem, transcript);
  if (!text) return;

  let summaries = [...summaryTexts(chat.summaries), text];
  if (summaries.length > MAX_SUMMARIES) {
    const older = summaries.slice(0, summaries.length - KEEP_RECENT_SUMMARIES);
    // まとめ直しに失敗しても、畳んだぶんは残す。次の実行でもう一度まとめ直す
    const merged = await complete(deps, chat, model, summaryMerge, older.join("\n\n")).catch((error) => {
      console.error("summary merge failed", error);
      return null;
    });
    if (merged) summaries = [merged, ...summaries.slice(-KEEP_RECENT_SUMMARIES)];
  }

  // リースが期限切れになって別の実行に追い越されていたら、畳んだ位置が進んでいる。そのときは書かずに捨てる
  await db.update(chats).set({
    summaries: summaries.map((t) => ({ text: t })),
    meta: sql`json_set(${chats.meta}, '$.summarized_upto_id', ${uptoId})`,
  }).where(and(eq(chats.id, chat.id), sql`coalesce(json_extract(${chats.meta}, '$.summarized_upto_id'), 0) = ${fromId}`));
}

// 1 回の要約。原価はその場で記録する (使えなかった出力のぶんも払っている)
async function complete(deps: Deps, chat: typeof chats.$inferSelect, model: AiModel, system: string, content: string): Promise<string | null> {
  let raw = "";
  const result = await streamCompletion(model, [
    { role: "system", content: system },
    { role: "user", content },
  ], { mode: "summary" }, deps.env, (delta) => {
    raw += delta;
  });
  await deps.db.insert(aiUsages).values({
    accountId: chat.accountId, aiModelId: model.id, chatId: chat.id, purpose: 1,
    promptTokens: result.promptTokens, cachedTokens: result.cachedTokens, completionTokens: result.completionTokens,
    reasoningTokens: result.reasoningTokens, costMicro: costMicro(model, result), gatewayLogId: result.gatewayLogId,
    finishReason: result.finishReason,
  });
  return extract(raw);
}

// 壊れた要素と空の本文は落とす (PromptBuilder の「これまでのあらすじ」と同じ読み方)
function summaryTexts(summaries: unknown[]): string[] {
  return summaries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const text = (entry as Record<string, unknown>).text;
    return typeof text === "string" && isPresent(text) ? [text] : [];
  });
}

async function sourceMessages(db: Db, chat: typeof chats.$inferSelect) {
  const all = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.status, MESSAGE_STATUSES.normal), gt(chatMessages.id, summarizedUptoId(chat))))
    .orderBy(asc(chatMessages.id));
  if (all.length <= ROLLING_KEEP_MESSAGES) return { messages: [], uptoId: null };
  const folded = all.slice(0, all.length - ROLLING_KEEP_MESSAGES);
  return { messages: folded.slice(-MAX_SOURCE_MESSAGES), uptoId: folded.at(-1)!.id };
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

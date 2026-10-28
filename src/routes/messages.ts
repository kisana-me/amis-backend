// メッセージの送信・生成の配信・キャンセル (本体の V1::Amis::MessagesController と Amis::ChatCompletionJob)
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, plots } from "../db/schema";
import { contentRating, findModelByAid, findModelById, ModelUnavailable, resolveModel } from "../generation/models";
import { runGeneration } from "../generation/run";
import { charLength, isBlank, rubyStrip } from "../generation/ruby-text";
import { type Emit, sseResponse } from "../generation/sse";
import { IN_FLIGHT, isStalled, pendingMessage, sweepStalled } from "../generation/stall";
import { rateText } from "../generation/text-rating";
import type { AppEnv } from "../env";
import { newAid } from "../lib/aid";
import { jsonBody, notFound } from "../lib/http";
import { requireSignin } from "../middleware/auth";
import { checkLimits, LimitError } from "../usage/limits";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";
import { scene, sceneStatus } from "../views/chat";
import type { ChatMessage } from "../views/context";
import { findChat } from "./chats";

const MAX_LENGTH = 2000;
// 生成中ではない人が途中経過を読むときの間隔と、読み続ける上限
const FOLLOW_INTERVAL_MS = 500;
const FOLLOW_LIMIT_MS = 300_000;

export const messageRoutes = new Hono<AppEnv>();

// ActiveModel::Type::Boolean と同じ。空なら null、偽を表す値以外はすべて真
const FALSE_VALUES = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
export function castBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return !FALSE_VALUES.has(value as never);
}

// 生成を頼む。通常の JSON で即返し、本文は POST /messages/:aid/stream で受け取る
messageRoutes.post("/chats/:aid/messages", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const body = await jsonBody(c);
  // auto は入力欄が空のときの自動継続。ユーザー発言を作らずに続きだけを生成させる
  const auto = castBoolean(body.auto) === true;
  const content = rubyStrip(String(body.content ?? ""));
  if (!auto && (isBlank(content) || charLength(content) > MAX_LENGTH)) {
    return c.json({ status: "error", message: `本文は1〜${MAX_LENGTH}文字で入力してください` }, 422);
  }

  const chat = await findChat(db, c.req.param("aid"), account.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");
  if (await pendingMessage(db, chat.id)) return c.json({ status: "error", message: "生成中です" }, 409);

  try {
    const [plot] = await db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
    const model = await resolveModel(db, await contentRating(db, plot),
      (await findModelByAid(db, body.model_aid)) ?? (await findModelById(db, chat.aiModelId)));
    await checkLimits(db, c.env, account.id);

    const assistant = newAid();
    const insertAssistant = db.insert(chatMessages).values({
      chatId: chat.id, aid: assistant, role: MESSAGE_ROLES.assistant, status: MESSAGE_STATUSES.pending,
      chapterKey: chat.currentChapterKey, content: [], aiModelId: model.id, meta: auto ? { auto: true } : {},
    });
    const updateChat = db.update(chats).set({
      lastMessageAt: new Date(),
      turnsInChapter: sql`${chats.turnsInChapter} + 1`,
      aiModelId: model.id,
      messagesCount: sql`${chats.messagesCount} + ${auto ? 1 : 2}`,
    }).where(eq(chats.id, chat.id));
    if (auto) {
      await db.batch([insertAssistant, updateChat]);
    } else {
      await db.batch([
        db.insert(chatMessages).values({
          chatId: chat.id, aid: newAid(), role: MESSAGE_ROLES.user, status: MESSAGE_STATUSES.normal,
          chapterKey: chat.currentChapterKey, content: [{ speaker: null, text: content }], autoRating: rateText(content),
        }),
        insertAssistant,
        updateChat,
      ]);
    }

    return c.json({
      status: "success",
      message_aid: assistant,
      // 順番待ちのキューはなくなった。フロントが数として読むので 0 を返す
      queue_position: 0,
      quota: { weekly_usage_percent: usagePercent(await weeklyCostMicro(db, account.id), Number(c.env.WEEKLY_COST_LIMIT_MICRO)) },
    });
  } catch (error) {
    if (error instanceof LimitError) {
      return c.json({ status: "error", message: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    }
    if (error instanceof ModelUnavailable) return c.json({ status: "error", message: error.message }, 422);
    throw error;
  }
});

// 生成の配信 (SSE)。本体の Amis::ChatChannel に当たり、流す JSON も同じ (snapshot → delta … → done)。
// pending のメッセージは、最初につないだ 1 本がその場で生成を受け持つ。
// ほかの接続 (別のタブやリロード) は D1 に書かれる途中経過を読んで差分を流す
messageRoutes.post("/messages/:aid/stream", requireSignin, async (c) => {
  const { db } = c.var;
  const message = await findOwnedMessage(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");

  const claimed = await db.update(chatMessages)
    .set({ status: MESSAGE_STATUSES.streaming, streamedAt: new Date() })
    .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, MESSAGE_STATUSES.pending)))
    .run();
  if (claimed.meta.changes > 0) {
    const [chat] = await db.select().from(chats).where(eq(chats.id, message.chatId)).limit(1);
    const [plot] = await db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
    const deps = { db, env: c.env, ownerName: c.var.currentAccount!.name };
    return sseResponse(c.executionCtx, (emit) => runGeneration(deps, chat, plot, { ...message, status: MESSAGE_STATUSES.streaming }, emit));
  }
  return sseResponse(c.executionCtx, (emit) => follow(db, message, emit));
});

// 生成は止まるまで D1 の状態を見て続けるので、キャンセルは状態を変えるだけでよい
messageRoutes.post("/messages/:aid/cancel", requireSignin, async (c) => {
  const { db } = c.var;
  const message = await findOwnedMessage(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");

  await db.update(chatMessages)
    .set({ status: MESSAGE_STATUSES.canceled, streamedAt: new Date() })
    .where(and(eq(chatMessages.id, message.id), inArray(chatMessages.status, IN_FLIGHT)));
  return c.json({ status: "success" });
});

// aid は全体で一意なので、チャットを経由させずに引く。持ち主以外には存在自体を返さない
async function findOwnedMessage(db: Db, aid: string, accountId: number): Promise<ChatMessage | null> {
  const [row] = await db.select({ message: chatMessages }).from(chatMessages)
    .innerJoin(chats, eq(chats.id, chatMessages.chatId))
    .where(and(eq(chatMessages.aid, aid), eq(chats.accountId, accountId))).limit(1);
  return row?.message ?? null;
}

const STATUS_LABELS: Record<number, string> = {
  [MESSAGE_STATUSES.normal]: "normal", [MESSAGE_STATUSES.failed]: "failed", [MESSAGE_STATUSES.canceled]: "canceled",
};

// 生成を受け持っていない接続。途中経過を D1 から読んで差分にして流し、終わったら確定版を送る
async function follow(db: Db, initial: ChatMessage, emit: Emit): Promise<void> {
  let message = initial;
  let sent = scene(message);
  let seq = 0;
  await emit({ type: "snapshot", seq, scene: sent, status: message.status === MESSAGE_STATUSES.streaming ? "streaming" : "pending" });

  const started = Date.now();
  while (IN_FLIGHT.includes(message.status as never) && Date.now() - started < FOLLOW_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS));
    const [latest] = await db.select().from(chatMessages).where(eq(chatMessages.id, message.id)).limit(1);
    // チャットごと消されたなど。送れるものが無いので終える
    if (!latest) return;
    message = latest;
    if (isStalled(message) && (await sweepStalled(db, message))) {
      message = { ...message, status: MESSAGE_STATUSES.failed };
    }
    if (!IN_FLIGHT.includes(message.status as never)) break;

    const current = scene(message);
    for (let i = 0; i < current.length; i++) {
      const before = sent[i]?.text ?? "";
      const line = current[i];
      // 前回までに送った文字の続きだけを送る。書き換わった行は done の確定版で直る
      if (!line.text.startsWith(before) || line.text.length === before.length) continue;
      await emit({
        seq: ++seq, i, speaker: line.speaker, delta: line.text.slice(before.length), done: false,
        ...(line.icon ? { icon: line.icon } : {}), ...(line.image ? { image: line.image } : {}),
      });
    }
    sent = current;
  }

  const status = sceneStatus(message);
  await emit({
    seq: ++seq, type: "done", status: STATUS_LABELS[message.status] ?? "failed", scene: scene(message),
    ...(Object.keys(status).length > 0 ? { scene_status: status } : {}),
  });
}

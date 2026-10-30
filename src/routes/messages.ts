// メッセージの送信・生成の配信・キャンセル (本体の V1::Amis::MessagesController と Amis::ChatCompletionJob)
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, plots } from "../db/schema";
import { contentRating, findModelByAid, findModelById, ModelUnavailable, resolveModel } from "../generation/models";
import { runGeneration } from "../generation/run";
import { charLength, headChars, isBlank, rubyStrip } from "../generation/ruby-text";
import { STATUS_KEYS, STATUS_LIMIT } from "../generation/scene-presenter";
import { writeScene } from "../generation/scene-writer";
import { variantsOf } from "../generation/variants";
import { type Emit, sseResponse } from "../generation/sse";
import { IN_FLIGHT, isStalled, pendingMessage, sweepStalled } from "../generation/stall";
import { rateText } from "../generation/text-rating";
import type { AppEnv } from "../env";
import { newAid } from "../lib/aid";
import { castBoolean, jsonBody, jstIso8601, notFound } from "../lib/http";
import { requireSignin } from "../middleware/auth";
import { checkLimits, LimitError } from "../usage/limits";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";
import { imageAids, messageJson, scene, sceneStatus } from "../views/chat";
import { loadersOf } from "../views/context";
import { paletteFor } from "../views/palette";
import type { ChatMessage } from "../views/context";
import { findChat } from "./chats";

const MAX_LENGTH = 2000;
// 生成中ではない人が途中経過を読むときの間隔と、読み続ける上限
const FOLLOW_INTERVAL_MS = 500;
const FOLLOW_LIMIT_MS = 300_000;

export const messageRoutes = new Hono<AppEnv>();

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
      content: [], aiModelId: model.id, meta: auto ? { auto: true } : {},
    });
    const updateChat = db.update(chats).set({
      lastMessageAt: new Date(),
      aiModelId: model.id,
      messagesCount: sql`${chats.messagesCount} + ${auto ? 1 : 2}`,
    }).where(eq(chats.id, chat.id));
    if (auto) {
      await db.batch([insertAssistant, updateChat]);
    } else {
      await db.batch([
        db.insert(chatMessages).values({
          chatId: chat.id, aid: newAid(), role: MESSAGE_ROLES.user, status: MESSAGE_STATUSES.normal,
          content: [{ speaker: null, text: content }], autoRating: rateText(content),
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
    const deps = { db, env: c.env, ownerName: c.var.currentAccount!.name, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
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

const MAX_INSTRUCTION = 200;

// 触れるのは末尾の返答だけ。それより前を書き換えても、AI は既にそれを前提に喋っており、
// 要約に畳まれていれば履歴にすら反映されない (本体の MessagesController#editable?)
async function editable(db: Db, message: ChatMessage): Promise<boolean> {
  if (message.role !== MESSAGE_ROLES.assistant || message.status !== MESSAGE_STATUSES.normal) return false;
  if (await pendingMessage(db, message.chatId)) return false;
  const [latest] = await db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.chatId, message.chatId), eq(chatMessages.status, MESSAGE_STATUSES.normal)))
    .orderBy(desc(chatMessages.id)).limit(1);
  return latest?.id === message.id;
}

// messages/show.json.jbuilder。snapshot は生成中のときだけ D1 の途中経過から作る
function messageShowJson(message: ChatMessage, variantAids: string[] = []) {
  const inFlight = IN_FLIGHT.includes(message.status as never);
  return {
    status: "success",
    message: messageJson(message),
    snapshot: inFlight ? { seq: 0, scene: scene(message), status: message.status === MESSAGE_STATUSES.streaming ? "streaming" : "pending" } : null,
    variant_aids: variantAids,
  };
}

// 画面復帰時に途中経過を取りに来る用 (本体の messages#show)
messageRoutes.post("/messages/:aid", requireSignin, async (c) => {
  const message = await findOwnedMessage(c.var.db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");
  return c.json(messageShowJson(message));
});

// 生成済みの返答をユーザーが直接書き換える。生成は伴わないので利用量も進行も動かない
messageRoutes.patch("/messages/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const message = await findOwnedMessage(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");
  if (!(await editable(db, message))) return c.json({ status: "error", message: "直近の返答だけが編集できます" }, 422);

  const body = await jsonBody(c);
  const [chat] = await db.select().from(chats).where(eq(chats.id, message.chatId)).limit(1);
  const [plot] = await db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
  // すでに使われている絵は、伏せてあっても保存できないと編集そのものが詰む
  const keep = imageAids(message);
  const result = writeScene(body.scene, await paletteFor(loadersOf(c), plot), keep);
  if (result.errors.length > 0) return c.json({ status: "error", message: result.errors[0] }, 422);

  const text = result.scene.map((line) => line.text).join("\n");
  const meta: Record<string, unknown> = { ...message.meta, edited_at: jstIso8601() };
  // 本文だけ直しても @@time/@@place/@@air は当時のまま残り、次のターンの few-shot に戻ってしまう。
  // 空にしたぶんはキーごと落とす (欠けた項目は前のターンのものが生きる)
  if ("scene_status" in body) meta.scene_status = sceneStatusParams(body.scene_status);
  const [updated] = await db.update(chatMessages).set({
    content: result.scene,
    // 差し替えた本文がレーティング判定を素通りしないよう、必ず振り直す
    autoRating: isBlank(text) ? null : rateText(text),
    meta,
  }).where(eq(chatMessages.id, message.id)).returning();
  return c.json(messageShowJson(updated));
});

function sceneStatusParams(rows: unknown): Record<string, string> {
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return {};
  const values = rows as Record<string, unknown>;
  return Object.fromEntries(STATUS_KEYS
    .map((key) => [key, headChars(rubyStrip(String(values[key] ?? "")), STATUS_LIMIT)] as const)
    .filter(([, value]) => !isBlank(value)));
}

// 直近の返答をやり直す。前の返答は消さずに兄弟として残り、フロントの < 2/3 > で選び直せる。
// 兄弟の連結と status の付け替えは、生成が成功した時点 (run.ts) まで遅らせる
messageRoutes.post("/messages/:aid/regenerate", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const message = await findOwnedMessage(db, c.req.param("aid"), account.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");
  if (!(await editable(db, message))) return c.json({ status: "error", message: "直近の返答だけがやり直せます" }, 422);

  const instruction = rubyStrip(String((await jsonBody(c)).instruction ?? ""));
  if (charLength(instruction) > MAX_INSTRUCTION) {
    return c.json({ status: "error", message: `指示は${MAX_INSTRUCTION}文字以内で入力してください` }, 422);
  }

  try {
    const [chat] = await db.select().from(chats).where(eq(chats.id, message.chatId)).limit(1);
    const [plot] = await db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
    const model = await resolveModel(db, await contentRating(db, plot), await findModelById(db, chat.aiModelId));
    await checkLimits(db, c.env, account.id);

    const aid = newAid();
    await db.batch([
      db.insert(chatMessages).values({
        chatId: chat.id, aid, role: MESSAGE_ROLES.assistant, status: MESSAGE_STATUSES.pending,
        content: [], aiModelId: model.id,
        meta: {
          regenerate_of: message.aid,
          ...(isBlank(instruction) ? {} : { instruction }),
          // 自動継続のやり直しは、やり直しても自動継続のまま
          auto: message.meta.auto === true,
        },
      }),
      // やり直しも 1 通として数える
      db.update(chats).set({ lastMessageAt: new Date(), messagesCount: sql`${chats.messagesCount} + 1` }).where(eq(chats.id, chat.id)),
    ]);
    return c.json({
      status: "success",
      message_aid: aid,
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

// やり直しでできた兄弟のうち、表示する 1 本を選び直す。生成しないので利用量も進行も動かない
messageRoutes.post("/messages/:aid/select", requireSignin, async (c) => {
  const { db } = c.var;
  const message = await findOwnedMessage(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!message) return notFound(c, "メッセージが見つかりませんでした");

  // 選び直せるのは、末尾の返答の兄弟だけ
  const variants = await variantsOf(db, message);
  const current = variants.find((v) => v.status === MESSAGE_STATUSES.normal);
  if (message.role !== MESSAGE_ROLES.assistant || !current || !(await editable(db, current))) {
    return c.json({ status: "error", message: "この返答は選べません" }, 422);
  }

  if (message.status !== MESSAGE_STATUSES.normal) {
    await db.batch([
      db.update(chatMessages).set({ status: MESSAGE_STATUSES.replaced }).where(eq(chatMessages.id, current.id)),
      db.update(chatMessages).set({ status: MESSAGE_STATUSES.normal }).where(eq(chatMessages.id, message.id)),
    ]);
  }
  const [selected] = await db.select().from(chatMessages).where(eq(chatMessages.id, message.id)).limit(1);
  return c.json(messageShowJson(selected, variants.map((v) => v.aid)));
});

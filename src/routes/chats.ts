import { and, desc, eq, gt, inArray, isNull, lt, max, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { inChunks } from "../db/client";
import {
  aiModels, CHAT_STATUSES, CONTENT_STATUSES, characters, chatMessages, chats, MESSAGE_ROLES, MESSAGE_STATUSES, personas,
  plots,
} from "../db/schema";
import { allowsRating, contentRating, findModelByAid, ModelUnavailable, resolveModel } from "../generation/models";
import { charLength, isPresent, rubyStrip } from "../generation/ruby-text";
import { newAid } from "../lib/aid";
import { findVisiblePlot } from "../queries/visibility";
import type { AppEnv } from "../env";
import { castBoolean, jsonBody, notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { IN_FLIGHT, pendingMessage } from "../generation/stall";
import { variantChain } from "../generation/variants";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";
import {
  chatJson, currentSceneStatus, excerpt, HIDDEN_MESSAGE_STATUSES, imageAids, isVisibleAssistant, messageJson,
} from "../views/chat";
import { type Chat, type ChatMessage, loadCasts, loadContext, loadersOf, type Plot, type ViewContext } from "../views/context";
import { chapterDefinitions, imageDisplayUrl, leadCast, openingImageAids, openingLines } from "../views/json";
import { paletteFor, type SceneImageRow, sceneImageCandidates } from "../views/palette";

const LIMIT = 30;
// チャットを開いたときと、上へ遡るときに 1 回で返すメッセージの数
const MESSAGE_LIMIT = 30;

export const chatRoutes = new Hono<AppEnv>();

// 自分のチャット。会話ログは作者にも見せないので、持ち主以外には存在自体を返さない
export async function findChat(db: Db, aid: string, accountId: number): Promise<Chat | null> {
  const [chat] = await db.select().from(chats)
    .where(and(eq(chats.aid, aid), eq(chats.accountId, accountId), notInArray(chats.status, [CHAT_STATUSES.deleted]))).limit(1);
  return chat ?? null;
}

// チャットの見出しに要るもの (プロット、モデル、ペルソナ) をまとめて引く
async function chatViews(c: Parameters<typeof loadersOf>[0], rows: Chat[], extraImageIds: number[] = []) {
  const { db } = c.var;
  const ids = <T,>(values: (T | null)[]) => values.filter((v): v is T => v !== null);
  const [plotRows, modelRows, personaRows] = await Promise.all([
    inChunks(rows.map((r) => r.plotId), (chunk) => db.select().from(plots).where(inArray(plots.id, chunk))),
    inChunks(ids(rows.map((r) => r.aiModelId)), (chunk) => db.select().from(aiModels).where(inArray(aiModels.id, chunk))),
    inChunks(ids(rows.map((r) => r.personaId)), (chunk) => db.select().from(personas).where(inArray(personas.id, chunk))),
  ]);
  const ctx = await loadContext(loadersOf(c), {
    plots: plotRows,
    imageIds: [...ids(personaRows.map((p) => p.iconId)), ...extraImageIds],
  });
  const plotById = new Map(plotRows.map((p) => [p.id, p]));
  const modelById = new Map(modelRows.map((m) => [m.id, m]));
  const personaById = new Map(personaRows.map((p) => [p.id, p]));
  return {
    ctx,
    json: (chat: Chat) => chatJson(chat, plotById.get(chat.plotId)!, ctx, {
      model: chat.aiModelId === null ? null : (modelById.get(chat.aiModelId) ?? null),
      persona: chat.personaId === null ? null : (personaById.get(chat.personaId) ?? null),
    }),
  };
}

// 一覧の次のページのカーソル。最後にメッセージした時刻 (まだなければ none) とチャットの id を "." でつなぐ
const chatCursor = (chat: Chat) => `${chat.lastMessageAt?.getTime() ?? "none"}.${chat.id}`;

// カーソルより後ろ (古い側) のチャット。並びは last_message_at の新しい順で、null は最後 (SQLite の降順)。同じなら id の大きい順
function olderChats(cursor: unknown): SQL | undefined {
  if (typeof cursor !== "string") return undefined;
  const [at, idText] = cursor.split(".");
  const id = Number(idText);
  if (!Number.isInteger(id)) return undefined;
  if (at === "none") return and(isNull(chats.lastMessageAt), lt(chats.id, id));
  const time = new Date(Number(at));
  if (Number.isNaN(time.getTime())) return undefined;
  return or(lt(chats.lastMessageAt, time), and(eq(chats.lastMessageAt, time), lt(chats.id, id)), isNull(chats.lastMessageAt));
}

// 本体の chats#index。tab: "archived" ならアーカイブだけ、それ以外はアーカイブ以外。
// 30 件ずつ。続きがあれば X-Next-Cursor を付け、cursor に渡すとその続きを返す
chatRoutes.post("/chats", requireSignin, async (c) => {
  const { db } = c.var;
  const body = await jsonBody(c);
  const archived = body.tab === "archived";
  const rows = await db.select().from(chats)
    .where(and(
      eq(chats.accountId, c.var.currentAccount!.id),
      archived ? eq(chats.status, CHAT_STATUSES.archived) : notInArray(chats.status, [CHAT_STATUSES.archived, CHAT_STATUSES.deleted]),
      olderChats(body.cursor),
    ))
    .orderBy(desc(chats.lastMessageAt), desc(chats.id)).limit(LIMIT);
  if (rows.length === LIMIT) c.header("X-Next-Cursor", chatCursor(rows.at(-1)!));

  // 一覧では章名の代わりに最後の 1 通 (normal のうち id が最大のもの) を出す
  const normals = await inChunks(rows.map((r) => r.id), (chunk) =>
    db.select().from(chatMessages).where(and(inArray(chatMessages.chatId, chunk), eq(chatMessages.status, MESSAGE_STATUSES.normal))));
  const last = new Map<number, ChatMessage>();
  for (const m of normals) if ((last.get(m.chatId)?.id ?? -1) < m.id) last.set(m.chatId, m);

  const views = await chatViews(c, rows);
  return c.json({
    status: "success",
    chats: rows.map((chat) => {
      const message = last.get(chat.id);
      return { ...views.json(chat), last_message: message ? excerpt(message) : null };
    }),
  });
});

// チャットを始める (本体の chats#create と ChatService.start!)。引けるのは一覧に出るものと、自分のもの
chatRoutes.post("/chats/create", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const body = await jsonBody(c);
  const plot = typeof body.plot_aid === "string" && body.plot_aid !== ""
    ? await findVisiblePlot(db, body.plot_aid, maxRatingFor(account), account)
    : null;
  if (!plot) return notFound(c, "プロットが見つかりませんでした");

  let model;
  try {
    model = await resolveModel(db, await contentRating(db, plot), await findModelByAid(db, body.model_aid));
  } catch (error) {
    if (error instanceof ModelUnavailable) return c.json({ status: "error", message: error.message }, 422);
    throw error;
  }
  const persona = await findPersona(db, plot.id, account.id, body.persona_aid);
  const opening = openingLines(plot);
  const firstChapter = chapterDefinitions(plot)[0]?.key ?? "";

  const [chat] = await db.insert(chats).values({
    aid: newAid(), accountId: account.id, plotId: plot.id, personaId: persona?.id ?? null, aiModelId: model.id,
    currentChapterKey: firstChapter, messagesCount: opening.length > 0 ? 1 : 0,
    lastMessageAt: opening.length > 0 ? new Date() : null,
  }).returning();

  // 遊ばれた回数は主役だけに加算する。全出演者に加算すると脇役が不当に人気になる
  const lead = leadCast(plot, { casts: await loadCasts(db, [plot]) } as ViewContext);
  await db.batch([
    db.update(plots).set({ chatsCount: sql`${plots.chatsCount} + 1` }).where(eq(plots.id, plot.id)),
    ...(lead ? [db.update(characters).set({ chatsCount: sql`${characters.chatsCount} + 1` }).where(eq(characters.id, lead.character.id))] : []),
    ...(opening.length > 0 ? [db.insert(chatMessages).values({
      aid: newAid(), chatId: chat.id, role: MESSAGE_ROLES.assistant, status: MESSAGE_STATUSES.normal,
      chapterKey: firstChapter, content: opening,
    })] : []),
  ]);
  return c.json(await chatShowJson(c, chat));
});

// 作者推奨は plot に、ユーザー作成は自分のものだけを引く (aid だけ知っていても他人のは引けない)
async function findPersona(db: Db, plotId: number, accountId: number, aid: unknown) {
  if (typeof aid !== "string" || aid.trim() === "") return null;
  const live = ne(personas.status, CONTENT_STATUSES.deleted);
  const [recommended] = await db.select().from(personas).where(and(live, eq(personas.plotId, plotId), eq(personas.aid, aid))).limit(1);
  if (recommended) return recommended;
  const [own] = await db.select().from(personas).where(and(live, eq(personas.accountId, accountId), eq(personas.aid, aid))).limit(1);
  return own ?? null;
}

// 本体の chats#show
chatRoutes.post("/chats/:aid", requireSignin, async (c) => {
  const chat = await findChat(c.var.db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");
  return c.json(await chatShowJson(c, chat));
});

// それより前のメッセージ。会話ログを上へ遡るときに使う。
// cursor は今見えているいちばん古いメッセージの aid (チャットを開いたときの older_messages_cursor か、この API の X-Next-Cursor)
chatRoutes.post("/chats/:aid/history", requireSignin, async (c) => {
  const { db } = c.var;
  const chat = await findChat(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");
  const cursor = (await jsonBody(c)).cursor;
  const [before] = typeof cursor === "string"
    ? await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.aid, cursor))).limit(1)
    : [];
  if (!before) return notFound(c, "メッセージが見つかりませんでした");

  const { page, olderCursor } = await messagePage(db, chat.id, before.id);
  if (olderCursor) c.header("X-Next-Cursor", olderCursor);
  return c.json({ status: "success", messages: page.map(messageJson) });
});

// 表示するメッセージを、新しい側から 1 ページ (beforeId があればそれより古いものだけ)。古い順に並べ直して返す。
// olderCursor は、まだ前があるときのいちばん古いメッセージの aid
async function messagePage(db: Db, chatId: number, beforeId?: number) {
  const rows = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.chatId, chatId),
      notInArray(chatMessages.status, HIDDEN_MESSAGE_STATUSES),
      beforeId === undefined ? undefined : lt(chatMessages.id, beforeId),
    ))
    .orderBy(desc(chatMessages.id)).limit(MESSAGE_LIMIT + 1);
  const page = rows.slice(0, MESSAGE_LIMIT).reverse();
  return { page, olderCursor: rows.length > MESSAGE_LIMIT ? page[0].aid : null };
}

// chats/show.json.jbuilder。開始・設定の変更のあとも同じ形で返す。メッセージは新しい側の 1 ページだけ
export async function chatShowJson(c: Parameters<typeof loadersOf>[0], chat: Chat) {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  // 止まっている生成はここで失敗に倒す。でないと「生成中です」のまま送れなくなる
  const pending = await pendingMessage(db, chat.id);
  const [[plot], { page: visible, olderCursor }, spent] = await Promise.all([
    db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1),
    messagePage(db, chat.id),
    weeklyCostMicro(db, account.id),
  ]);

  const sceneImageRows = await sceneImageCandidates(db, plot);
  const views = await chatViews(c, [chat], sceneImageRows.map((r) => r.imageId));

  return {
    status: "success",
    chat: {
      ...views.json(chat),
      summaries: chat.summaries,
      scene_status: currentSceneStatus(
        visible.filter((m) => m.role === MESSAGE_ROLES.assistant).reverse().slice(0, 10),
      ),
      // jbuilder はブロックの中で何も書かないとキーごと出さないので、空なら付けない
      ...sceneImagesJson(plot, sceneImageRows, views.ctx),
    },
    messages: visible.map(messageJson),
    older_messages_cursor: olderCursor,
    pending_message_aid: pending?.aid ?? null,
    variant_aids: await variantAids(db, chat.id, visible),
    quota: { weekly_usage_percent: usagePercent(spent, Number(c.env.WEEKLY_COST_LIMIT_MICRO)) },
  };
}

const REPLY_STYLE_KEYS: Record<string, number> = { balanced: 0, dialogue: 1, narration: 2 };
const MAX_TITLE = 100;

// チャット設定モーダルからの更新。渡ってきたキーだけを触る (本体の chats#update)
chatRoutes.patch("/chats/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const chat = await findChat(db, c.req.param("aid"), account.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");
  const body = await jsonBody(c);
  const error = (message: string) => c.json({ status: "error", message }, 422);

  const values: Partial<typeof chats.$inferInsert> = {};
  if ("title" in body) {
    const title = rubyStrip(String(body.title ?? ""));
    if (charLength(title) > MAX_TITLE) return error(`タイトルは${MAX_TITLE}文字以内で入力してください`);
    values.title = title;
  }
  if ("choice_mode" in body) values.choiceMode = castBoolean(body.choice_mode) === true;
  // アーカイブは status で表す。解除したときに完結済みへ戻せるよう finished_at を見る
  if ("archived" in body) {
    values.status = castBoolean(body.archived) === true
      ? CHAT_STATUSES.archived
      : chat.finishedAt !== null ? CHAT_STATUSES.finished : CHAT_STATUSES.normal;
  }
  if ("reply_style" in body) {
    const style = REPLY_STYLE_KEYS[String(body.reply_style ?? "")];
    if (style === undefined) return error("応答スタイルが不正です");
    values.replyStyle = style;
  }
  if ("model_aid" in body) {
    const model = await findModelByAid(db, body.model_aid);
    if (!model || model.status !== CONTENT_STATUSES.normal) return error("モデルが見つかりませんでした");
    const [plot] = await db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
    if (!allowsRating(model, await contentRating(db, plot))) return error("このプロットのレーティングでは使えないモデルです");
    values.aiModelId = model.id;
  }
  if ("persona_aid" in body) {
    if (isPresent(body.persona_aid)) {
      const persona = await findPersona(db, chat.plotId, account.id, body.persona_aid);
      if (!persona) return error("ペルソナが見つかりませんでした");
      values.personaId = persona.id;
    } else {
      values.personaId = null;
    }
  }

  const [updated] = Object.keys(values).length > 0
    ? await db.update(chats).set(values).where(eq(chats.id, chat.id)).returning()
    : [chat];
  return c.json(await chatShowJson(c, updated));
});

// ソフトデリート。進行中の生成は止めてから消す (本体の ChatService.soft_delete!)
chatRoutes.delete("/chats/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const chat = await findChat(db, c.req.param("aid"), c.var.currentAccount!.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");

  await db.batch([
    db.update(chatMessages).set({ status: MESSAGE_STATUSES.canceled, streamedAt: new Date() })
      .where(and(eq(chatMessages.chatId, chat.id), inArray(chatMessages.status, IN_FLIGHT))),
    db.update(chats).set({ status: CHAT_STATUSES.deleted }).where(eq(chats.id, chat.id)),
  ]);
  return c.json({ status: "success" });
});

// 本文を編集するときに選べる絵の一覧 (本体の chats#palette)
chatRoutes.post("/chats/:aid/palette", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const chat = await findChat(db, c.req.param("aid"), account.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");

  const [[plot], [latest]] = await Promise.all([
    db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1),
    db.select().from(chatMessages)
      .where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.role, MESSAGE_ROLES.assistant), eq(chatMessages.status, MESSAGE_STATUSES.normal)))
      .orderBy(desc(chatMessages.id)).limit(1),
  ]);
  // 直近の返答が使っている絵は、作者が伏せた絵でも候補に残す (選び直せないと保存もできなくなるため)
  const keep = latest ? imageAids(latest) : new Set<string>();
  return c.json({ status: "success", ...(await paletteFor(loadersOf(c), plot, keep)) });
});

// scene の icon / image に入っている aid を URL に引き直す表 (本体の Chat#scene_images)。
// 説明が付いた絵は AI が選べるので全部、導入で作者が名指しした絵は説明が無くても混ぜる
function sceneImagesJson(plot: Plot, rows: SceneImageRow[], ctx: ViewContext) {
  const named = new Set(openingImageAids(plot));
  const table: Record<string, string> = {};
  for (const row of rows) {
    const image = ctx.images.get(row.imageId);
    if (!image || image.aid in table) continue;
    if (row.situation.trim() !== "" || named.has(image.aid)) table[image.aid] = imageDisplayUrl(image, ctx);
  }
  return Object.keys(table).length > 0 ? { scene_images: table } : {};
}

// 末尾の返答をやり直してできた兄弟。1 本しかなければ空 (本体の ChatsController#variant_aids)。
// 兄弟はどれも、その返答を求めた直前のユーザーの発言より後ろにあるので、そこから先だけを読む
async function variantAids(db: Db, chatId: number, visible: ChatMessage[]): Promise<string[]> {
  const tail = [...visible].reverse().find(isVisibleAssistant);
  if (!tail) return [];
  const [prompt] = await db.select({ id: max(chatMessages.id) }).from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), eq(chatMessages.role, MESSAGE_ROLES.user), lt(chatMessages.id, tail.id)));
  const around = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), gt(chatMessages.id, prompt?.id ?? 0)));
  const list = variantChain(tail, around);
  return list.length > 1 ? list.map((m) => m.aid) : [];
}

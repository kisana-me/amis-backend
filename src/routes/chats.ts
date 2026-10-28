import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { inChunks } from "../db/client";
import {
  aiModels, CHAT_STATUSES, CONTENT_STATUSES, chatMessages, chats, characterImages, MESSAGE_ROLES, MESSAGE_STATUSES, personas, plotImages, plots,
} from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody, notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { requireSignin } from "../middleware/auth";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";
import {
  chatJson, currentSceneStatus, excerpt, HIDDEN_MESSAGE_STATUSES, imageAids, isVisibleAssistant, messageJson,
} from "../views/chat";
import { type Chat, type ChatMessage, loadCasts, loadContext, loadersOf, type Plot, type ViewContext } from "../views/context";
import { imageDisplayUrl, imageUrl, openingImageAids } from "../views/json";

const LIMIT = 30;

export const chatRoutes = new Hono<AppEnv>();

// 自分のチャット。会話ログは作者にも見せないので、持ち主以外には存在自体を返さない
async function findChat(db: Db, aid: string, accountId: number): Promise<Chat | null> {
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

// 本体の chats#index。tab: "archived" ならアーカイブだけ、それ以外はアーカイブ以外
chatRoutes.post("/chats", requireSignin, async (c) => {
  const { db } = c.var;
  const archived = (await jsonBody(c)).tab === "archived";
  const rows = await db.select().from(chats)
    .where(and(
      eq(chats.accountId, c.var.currentAccount!.id),
      archived ? eq(chats.status, CHAT_STATUSES.archived) : notInArray(chats.status, [CHAT_STATUSES.archived, CHAT_STATUSES.deleted]),
    ))
    .orderBy(desc(chats.lastMessageAt), desc(chats.id)).limit(LIMIT);

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

// 本体の chats#show
chatRoutes.post("/chats/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const chat = await findChat(db, c.req.param("aid"), account.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");

  const [[plot], all, spent] = await Promise.all([
    db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1),
    db.select().from(chatMessages).where(eq(chatMessages.chatId, chat.id)).orderBy(asc(chatMessages.id)),
    weeklyCostMicro(db, account.id),
  ]);
  const visible = all.filter((m) => !HIDDEN_MESSAGE_STATUSES.includes(m.status as never));
  const pending = all.filter((m) => m.status === MESSAGE_STATUSES.pending || m.status === MESSAGE_STATUSES.streaming).at(-1);

  const sceneImageRows = await sceneImageCandidates(db, plot);
  const views = await chatViews(c, [chat], sceneImageRows.map((r) => r.imageId));

  return c.json({
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
    pending_message_aid: pending?.aid ?? null,
    variant_aids: variantAids(visible, all),
    quota: { weekly_usage_percent: usagePercent(spent, Number(c.env.WEEKLY_COST_LIMIT_MICRO)) },
  });
});

// 本文を編集するときに選べる絵の一覧 (本体の chats#palette)
chatRoutes.post("/chats/:aid/palette", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const chat = await findChat(db, c.req.param("aid"), account.id);
  if (!chat) return notFound(c, "チャットが見つかりませんでした");

  const [[plot], messages] = await Promise.all([
    db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1),
    db.select().from(chatMessages)
      .where(and(eq(chatMessages.chatId, chat.id), eq(chatMessages.role, MESSAGE_ROLES.assistant), eq(chatMessages.status, MESSAGE_STATUSES.normal)))
      .orderBy(desc(chatMessages.id)).limit(1),
  ]);
  // 直近の返答が使っている絵は、作者が伏せた絵でも候補に残す (選び直せないと保存もできなくなるため)
  const keep = messages[0] ? imageAids(messages[0]) : new Set<string>();
  const rows = await sceneImageCandidates(db, plot);
  const ctx = await loadContext(loadersOf(c), { imageIds: rows.map((r) => r.imageId) });
  const maxRating = maxRatingFor(account);

  // ラベルの無い絵は scene_images に載らない = 選んでも表示できないので候補にしない
  const entry = (row: SceneImageRow) => {
    const image = ctx.images.get(row.imageId);
    if (row.secret && !(image && keep.has(image.aid))) return [];
    if (row.situation.trim() === "" || !image || image.status !== CONTENT_STATUSES.normal || (image.rating ?? 0) > maxRating) return [];
    return [{ aid: image.aid, url: imageUrl(image, ctx), situation: row.situation, secret: row.secret }];
  };
  const casts = (await loadCasts(db, [plot])).get(plot.id) ?? [];
  return c.json({
    status: "success",
    plot_images: rows.filter((r) => r.kind === "plot").flatMap(entry),
    characters: Object.fromEntries(casts.map(({ plotCharacter, character }) => [
      plotCharacter.speakerKey,
      rows.filter((r) => r.kind === "character" && r.characterId === character.id).flatMap(entry),
    ])),
  });
});

type SceneImageRow = { kind: "plot" | "character"; characterId: number | null; imageId: number; situation: string; secret: boolean };

// プロットの絵 (position, id 順) → 出演者の絵 (出演順、各キャラの position, id 順)
async function sceneImageCandidates(db: Db, plot: Plot): Promise<SceneImageRow[]> {
  const [plotRows, casts] = await Promise.all([
    db.select().from(plotImages).where(eq(plotImages.plotId, plot.id)).orderBy(asc(plotImages.position), asc(plotImages.id)),
    loadCasts(db, [plot]),
  ]);
  const characterIds = (casts.get(plot.id) ?? []).map((cast) => cast.character.id);
  const characterRows = characterIds.length === 0 ? [] : await inChunks(characterIds, (chunk) =>
    db.select().from(characterImages).where(inArray(characterImages.characterId, chunk)));
  characterRows.sort((a, b) => a.position - b.position || a.id - b.id);

  return [
    ...plotRows.map((r) => ({ kind: "plot" as const, characterId: null, imageId: r.imageId, situation: r.situation, secret: r.secret })),
    ...characterIds.flatMap((id) => characterRows.filter((r) => r.characterId === id)
      .map((r) => ({ kind: "character" as const, characterId: id, imageId: r.imageId, situation: r.situation, secret: r.secret }))),
  ];
}

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

// 末尾の返答をやり直してできた兄弟。replaced_by_id を「次に生成した 1 本」へのリンクとして辿る。
// 1 本しかなければ空 (本体の ChatsController#variant_aids)
function variantAids(visible: ChatMessage[], all: ChatMessage[]): string[] {
  const tail = [...visible].reverse().find(isVisibleAssistant);
  if (!tail) return [];

  const byId = new Map(all.map((m) => [m.id, m]));
  const previousOf = new Map(all.filter((m) => m.replacedById !== null).map((m) => [m.replacedById!, m]));
  let root = tail;
  for (let prev = previousOf.get(root.id); prev; prev = previousOf.get(root.id)) root = prev;

  const list = [root];
  for (let next = root.replacedById; next !== null; ) {
    const message = byId.get(next);
    if (!message) break;
    list.push(message);
    next = message.replacedById;
  }
  return list.length > 1 ? list.map((m) => m.aid) : [];
}

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aiModels } from "./ai-models";
import { characters } from "./characters";
import { chats } from "./chats";
import { aid, jsonValid, meta, ratings, timestamps } from "./columns";
import { MESSAGE_STATUSES } from "./enums";

// いちばん大きくなるテーブルなので軽く保つ。トークン数や応答時間は ai_usages に置く
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey(),
  aid: aid(),
  chatId: integer("chat_id").notNull().references(() => chats.id),
  role: integer("role").notNull(),
  status: integer("status").notNull().default(MESSAGE_STATUSES.normal),
  // シーンの行の配列 (本体と同じ JSON)
  content: text("content", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  chapterKey: text("chapter_key").notNull().default(""),
  speakerCharacterId: integer("speaker_character_id").references(() => characters.id),
  replacedById: integer("replaced_by_id"),
  aiModelId: integer("ai_model_id").references(() => aiModels.id, { onDelete: "set null" }),
  ...ratings(false),
  streamedAt: integer("streamed_at", { mode: "timestamp_ms" }),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_chat_messages_on_aid").on(t.aid),
  index("index_chat_messages_on_chat_id_and_id").on(t.chatId, t.id),
  index("index_chat_messages_on_status").on(t.status),
  index("index_chat_messages_on_replaced_by_id").on(t.replacedById),
  jsonValid("content"),
  jsonValid("meta"),
]);

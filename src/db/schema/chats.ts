import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aiModels } from "./ai-models";
import { aid, jsonValid, meta, timestamps } from "./columns";
import { CHAT_STATUSES, REPLY_STYLES } from "./enums";
import { personas } from "./personas";
import { plots } from "./plots";

// MVP ではログイン済みのアカウントだけが持ち主。ゲスト (guest_id) は後で足す
export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey(),
  aid: aid(),
  accountId: integer("account_id").notNull(),
  plotId: integer("plot_id").notNull().references(() => plots.id),
  personaId: integer("persona_id").references(() => personas.id),
  aiModelId: integer("ai_model_id").references(() => aiModels.id, { onDelete: "set null" }),
  title: text("title").notNull().default(""),
  status: integer("status").notNull().default(CHAT_STATUSES.normal),
  replyStyle: integer("reply_style").notNull().default(REPLY_STYLES.balanced),
  choiceMode: integer("choice_mode", { mode: "boolean" }).notNull().default(false),
  currentChapterKey: text("current_chapter_key").notNull().default(""),
  turnsInChapter: integer("turns_in_chapter").notNull().default(0),
  endingKey: text("ending_key").notNull().default(""),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  summaries: text("summaries", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  messagesCount: integer("messages_count").notNull().default(0),
  lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_chats_on_aid").on(t.aid),
  index("index_chats_on_account_id_and_last_message_at").on(t.accountId, t.lastMessageAt),
  index("index_chats_on_plot_id_and_ending_key").on(t.plotId, t.endingKey),
  index("index_chats_on_persona_id").on(t.personaId),
  index("index_chats_on_ai_model_id").on(t.aiModelId),
  jsonValid("summaries"),
  jsonValid("meta"),
]);

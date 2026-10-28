import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { aiModels } from "./ai-models";
import { chatMessages } from "./chat-messages";
import { chats } from "./chats";
import { createdAt } from "./columns";
import { AI_USAGE_PURPOSES } from "./enums";

// AI 呼び出し 1 回ごとの記録。週の原価上限の集計と、メッセージごとのトークン数・応答時間に使う
export const aiUsages = sqliteTable("ai_usages", {
  id: integer("id").primaryKey(),
  accountId: integer("account_id"),
  aiModelId: integer("ai_model_id").references(() => aiModels.id, { onDelete: "set null" }),
  chatId: integer("chat_id").references(() => chats.id, { onDelete: "set null" }),
  chatMessageId: integer("chat_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  purpose: integer("purpose").notNull().default(AI_USAGE_PURPOSES.chat),
  promptTokens: integer("prompt_tokens"),
  cachedTokens: integer("cached_tokens"),
  completionTokens: integer("completion_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  costMicro: integer("cost_micro"),
  finishReason: text("finish_reason"),
  ttftMs: integer("ttft_ms"),
  latencyMs: integer("latency_ms"),
  gatewayLogId: text("gateway_log_id"),
  createdAt: createdAt(),
}, (t) => [
  index("index_ai_usages_on_account_id_and_created_at").on(t.accountId, t.createdAt),
  index("index_ai_usages_on_ai_model_id").on(t.aiModelId),
  index("index_ai_usages_on_chat_id").on(t.chatId),
  index("index_ai_usages_on_chat_message_id").on(t.chatMessageId),
  index("index_ai_usages_on_created_at").on(t.createdAt),
]);

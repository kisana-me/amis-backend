import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, type Json, jsonValid, meta, timestamps } from "./columns";
import { AI_MODEL_APIS, AI_MODEL_ROUTES, AI_MODEL_TIERS, CONTENT_STATUSES, RATINGS } from "./enums";

export const aiModels = sqliteTable("ai_models", {
  id: integer("id").primaryKey(),
  aid: aid(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  provider: text("provider").notNull(),
  upstreamModel: text("upstream_model").notNull(),
  api: integer("api").notNull().default(AI_MODEL_APIS.chat_completions),
  route: integer("route").notNull().default(AI_MODEL_ROUTES.auto),
  tier: integer("tier").notNull().default(AI_MODEL_TIERS.free),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  maxRating: integer("max_rating").notNull().default(RATINGS.r18),
  contextWindow: integer("context_window").notNull().default(0),
  maxOutputTokens: integer("max_output_tokens").notNull().default(0),
  inputPriceMicro: integer("input_price_micro").notNull().default(0),
  cachedInputPriceMicro: integer("cached_input_price_micro").notNull().default(0),
  outputPriceMicro: integer("output_price_micro").notNull().default(0),
  position: integer("position").notNull().default(0),
  requestParams: text("request_params", { mode: "json" }).$type<Json>().notNull().default({}),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_ai_models_on_aid").on(t.aid),
  jsonValid("meta"),
  jsonValid("request_params"),
]);

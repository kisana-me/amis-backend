import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, jsonValid, meta, timestamps } from "./columns";
import { CONTENT_STATUSES } from "./enums";

// キャラとプロットへの通報 (本体の reports のうち、Amis の分)。対応 (ロック・mod_rating の上書き) も Amis の DB で行う
export const REPORT_CATEGORIES = {
  other: 0, spam: 1, hate: 2, disinformation: 3, violence: 4, sensitive: 5, suicide: 6, illegal: 7, theft: 8, privacy: 9,
} as const;

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey(),
  aid: aid(),
  // 未サインインでも通報できる
  accountId: integer("account_id"),
  // amis_character / amis_plot (本体の target_type と同じ値)
  targetType: text("target_type").notNull(),
  targetId: integer("target_id").notNull(),
  category: integer("category").notNull().default(REPORT_CATEGORIES.other),
  description: text("description").notNull().default(""),
  // 通報者へのお知らせ (運営が書く)
  announcement: text("announcement").notNull().default(""),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_reports_on_aid").on(t.aid),
  index("index_reports_on_target_type_and_target_id").on(t.targetType, t.targetId),
  index("index_reports_on_account_id").on(t.accountId),
  jsonValid("meta"),
]);

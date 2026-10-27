import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts";
import { createdAt } from "./columns";

// 1 日の無料枠の消費数。消費は UPDATE ... WHERE used_count < ? で行う
export const dailyQuotas = sqliteTable("daily_quotas", {
  accountId: integer("account_id").notNull().references(() => accounts.id),
  // JST の日付 (YYYY-MM-DD)
  usedOn: text("used_on").notNull(),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.usedOn] }),
]);

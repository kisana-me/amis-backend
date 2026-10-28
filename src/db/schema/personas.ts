import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, timestamps } from "./columns";
import { CONTENT_STATUSES } from "./enums";
import { images } from "./images";
import { plots } from "./plots";

// 持ち主はアカウント (ユーザーの分身) かプロット (プロット指定の主人公) のどちらか一方
export const personas = sqliteTable("personas", {
  id: integer("id").primaryKey(),
  aid: aid(),
  accountId: integer("account_id"),
  plotId: integer("plot_id").references(() => plots.id),
  iconId: integer("icon_id").references(() => images.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_personas_on_aid").on(t.aid),
  index("index_personas_on_account_id").on(t.accountId),
  index("index_personas_on_plot_id").on(t.plotId),
  index("index_personas_on_icon_id").on(t.iconId),
  check("personas_owner_xor", sql`(account_id IS NULL) <> (plot_id IS NULL)`),
]);

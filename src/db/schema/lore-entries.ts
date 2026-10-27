import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { timestamps } from "./columns";
import { lores } from "./lores";

export const loreEntries = sqliteTable("lore_entries", {
  id: integer("id").primaryKey(),
  loreId: integer("lore_id").notNull().references(() => lores.id),
  title: text("title").notNull().default(""),
  keywords: text("keywords").notNull(),
  body: text("body").notNull(),
  ...timestamps,
}, (t) => [
  index("index_lore_entries_on_lore_id").on(t.loreId),
]);

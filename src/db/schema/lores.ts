import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, jsonValid, meta, timestamps } from "./columns";
import { CONTENT_STATUSES, VISIBILITIES } from "./enums";

export const lores = sqliteTable("lores", {
  id: integer("id").primaryKey(),
  aid: aid(),
  authorId: integer("author_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  allowAttach: integer("allow_attach", { mode: "boolean" }).notNull().default(true),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  visibility: integer("visibility").notNull().default(VISIBILITIES.opened),
  entriesCount: integer("entries_count").notNull().default(0),
  plotsCount: integer("plots_count").notNull().default(0),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_lores_on_aid").on(t.aid),
  index("index_lores_on_author_id").on(t.authorId),
  index("index_lores_on_status_and_visibility").on(t.status, t.visibility),
  jsonValid("meta"),
]);

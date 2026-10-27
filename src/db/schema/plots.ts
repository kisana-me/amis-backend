import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts";
import { aid, jsonValid, meta, ratings, timestamps } from "./columns";
import { CONTENT_STATUSES, VISIBILITIES } from "./enums";
import { images } from "./images";

export const plots = sqliteTable("plots", {
  id: integer("id").primaryKey(),
  aid: aid(),
  authorId: integer("author_id").references(() => accounts.id),
  iconId: integer("icon_id").references(() => images.id),
  forkedFromId: integer("forked_from_id"),
  title: text("title").notNull(),
  tagline: text("tagline").notNull().default(""),
  description: text("description").notNull().default(""),
  situation: text("situation").notNull().default(""),
  situationPublic: integer("situation_public", { mode: "boolean" }).notNull().default(false),
  chapters: text("chapters", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  openingScene: text("opening_scene", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  allowFork: integer("allow_fork", { mode: "boolean" }).notNull().default(false),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  visibility: integer("visibility").notNull().default(VISIBILITIES.opened),
  ...ratings(true),
  chatsCount: integer("chats_count").notNull().default(0),
  clearsCount: integer("clears_count").notNull().default(0),
  likesCount: integer("likes_count").notNull().default(0),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_plots_on_aid").on(t.aid),
  index("index_plots_on_author_id").on(t.authorId),
  index("index_plots_on_icon_id").on(t.iconId),
  index("index_plots_on_forked_from_id").on(t.forkedFromId),
  index("index_plots_on_rating").on(t.rating),
  index("index_plots_on_status_and_visibility_and_clears_count").on(t.status, t.visibility, t.clearsCount),
  jsonValid("chapters"),
  jsonValid("opening_scene"),
  jsonValid("meta"),
]);

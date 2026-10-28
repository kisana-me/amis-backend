import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, jsonValid, meta, ratingsWithDerived, timestamps } from "./columns";
import { CONTENT_STATUSES, VISIBILITIES } from "./enums";
import { images } from "./images";

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey(),
  aid: aid(),
  authorId: integer("author_id"),
  iconId: integer("icon_id").references(() => images.id),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  description: text("description").notNull().default(""),
  persona: text("persona").notNull(),
  personaPublic: integer("persona_public", { mode: "boolean" }).notNull().default(false),
  allowCasting: integer("allow_casting", { mode: "boolean" }).notNull().default(true),
  allowFork: integer("allow_fork", { mode: "boolean" }).notNull().default(false),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  visibility: integer("visibility").notNull().default(VISIBILITIES.opened),
  ...ratingsWithDerived(),
  chatsCount: integer("chats_count").notNull().default(0),
  leadsCount: integer("leads_count").notNull().default(0),
  likesCount: integer("likes_count").notNull().default(0),
  messagesCount: integer("messages_count").notNull().default(0),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_characters_on_aid").on(t.aid),
  index("index_characters_on_author_id").on(t.authorId),
  index("index_characters_on_icon_id").on(t.iconId),
  index("index_characters_on_rating").on(t.rating),
  index("index_characters_on_status_and_visibility_and_chats_count").on(t.status, t.visibility, t.chatsCount),
  jsonValid("meta"),
]);

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, jsonValid, meta, ratings, timestamps } from "./columns";
import { CONTENT_STATUSES, VISIBILITIES } from "./enums";

// 本体の images は使わず、Amis の画像だけを持つ。実体は R2 の
//   amis/images/originals/{aid}.{ext} と amis/images/variants/{aid}/{variant}.webp
export const images = sqliteTable("images", {
  id: integer("id").primaryKey(),
  aid: aid(),
  accountId: integer("account_id"),
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
  originalKey: text("original_key"),
  originalExt: text("original_ext"),
  // 生成済みのバリアント名の配列
  variants: text("variants", { mode: "json" }).$type<string[]>().notNull().default([]),
  width: integer("width"),
  height: integer("height"),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  visibility: integer("visibility").notNull().default(VISIBILITIES.opened),
  ...ratings(false),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_images_on_aid").on(t.aid),
  index("index_images_on_account_id").on(t.accountId),
  index("index_images_on_rating").on(t.rating),
  jsonValid("variants"),
  jsonValid("meta"),
]);

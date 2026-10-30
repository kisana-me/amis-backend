import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, jsonValid, meta, ratings, timestamps } from "./columns";
import { CONTENT_STATUSES, VISIBILITIES } from "./enums";

// 本体の images は使わず、Amis の画像だけを持つ。実体は Amis の R2 バケット (amis-media) の
//   images/variants/{aid}.webp     表示用に変換したもの (本体のバケットと同じキー。移行は同じキーのままコピーする)
// 元の画像は置かない (本体も今は残していない)。original_key / original_ext は使っていない
export const images = sqliteTable("images", {
  id: integer("id").primaryKey(),
  aid: aid(),
  accountId: integer("account_id"),
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
  originalKey: text("original_key"),
  originalExt: text("original_ext"),
  // 変換の種類 (amis-character / amis-plot など)。null なら変換がまだ終わっていない (本体と同じ)
  variantType: text("variant_type"),
  width: integer("width"),
  height: integer("height"),
  status: integer("status").notNull().default(CONTENT_STATUSES.normal),
  visibility: integer("visibility").notNull().default(VISIBILITIES.opened),
  ...ratings(),
  meta: meta(),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_images_on_aid").on(t.aid),
  index("index_images_on_account_id").on(t.accountId),
  index("index_images_on_rating").on(t.rating),
  jsonValid("meta"),
]);

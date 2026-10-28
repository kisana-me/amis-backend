// 中間テーブル。作って消すだけのもの (いいね・ロアの紐付け) は id を持たず複合主キーにする。
// どれも updated_at は持たない
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { characters } from "./characters";
import { createdAt } from "./columns";
import { images } from "./images";
import { lores } from "./lores";
import { plots } from "./plots";

// プロットの出演者。speaker_key はシーンの行で話者を指す値
export const plotCharacters = sqliteTable("plot_characters", {
  id: integer("id").primaryKey(),
  plotId: integer("plot_id").notNull().references(() => plots.id),
  characterId: integer("character_id").notNull().references(() => characters.id),
  speakerKey: text("speaker_key", { length: 32 }).notNull(),
  roleName: text("role_name").notNull().default(""),
  roleDescription: text("role_description").notNull().default(""),
  isLead: integer("is_lead", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("index_plot_characters_on_plot_id_and_character_id").on(t.plotId, t.characterId),
  uniqueIndex("index_plot_characters_on_plot_id_and_speaker_key").on(t.plotId, t.speakerKey),
  index("index_plot_characters_on_character_id_and_is_lead").on(t.characterId, t.isLead),
]);

// 詳細画面で並べる立ち絵など。カードのアイコン (characters.icon_id) とは別枠
export const characterImages = sqliteTable("character_images", {
  id: integer("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id),
  imageId: integer("image_id").notNull().references(() => images.id),
  situation: text("situation", { length: 50 }).notNull().default(""),
  secret: integer("secret", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("index_character_images_on_character_id_and_image_id").on(t.characterId, t.imageId),
  index("index_character_images_on_character_id_and_position").on(t.characterId, t.position),
  index("index_character_images_on_image_id").on(t.imageId),
]);

export const plotImages = sqliteTable("plot_images", {
  id: integer("id").primaryKey(),
  plotId: integer("plot_id").notNull().references(() => plots.id),
  imageId: integer("image_id").notNull().references(() => images.id),
  situation: text("situation", { length: 50 }).notNull().default(""),
  secret: integer("secret", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("index_plot_images_on_plot_id_and_image_id").on(t.plotId, t.imageId),
  index("index_plot_images_on_plot_id_and_position").on(t.plotId, t.position),
  index("index_plot_images_on_image_id").on(t.imageId),
]);

export const plotLores = sqliteTable("plot_lores", {
  plotId: integer("plot_id").notNull().references(() => plots.id),
  loreId: integer("lore_id").notNull().references(() => lores.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.plotId, t.loreId] }),
  index("index_plot_lores_on_lore_id").on(t.loreId),
]);

// 「自分のいいね一覧」は (account_id, created_at) で新しい順に並べる
export const characterLikes = sqliteTable("character_likes", {
  accountId: integer("account_id").notNull(),
  characterId: integer("character_id").notNull().references(() => characters.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.characterId] }),
  index("index_character_likes_on_account_id_and_created_at").on(t.accountId, t.createdAt),
  index("index_character_likes_on_character_id").on(t.characterId),
]);

export const plotLikes = sqliteTable("plot_likes", {
  accountId: integer("account_id").notNull(),
  plotId: integer("plot_id").notNull().references(() => plots.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.plotId] }),
  index("index_plot_likes_on_account_id_and_created_at").on(t.accountId, t.createdAt),
  index("index_plot_likes_on_plot_id").on(t.plotId),
]);

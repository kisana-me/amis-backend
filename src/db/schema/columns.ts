// テーブル間で共通のカラム定義
// - 時刻は epoch ミリ秒の integer (Drizzle では Date として扱う)
// - JSON は text に入れ、json_valid の CHECK を付ける
import { sql } from "drizzle-orm";
import { check, integer, text } from "drizzle-orm/sqlite-core";
import { RATINGS } from "./enums";

export type Json = Record<string, unknown>;

export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

export const timestamps = {
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
    .$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
};

export const aid = () => text("aid", { length: 14 }).notNull();
export const meta = () => text("meta", { mode: "json" }).$type<Json>().notNull().default({});
export const jsonValid = (column: string) => check(column, sql`json_valid(${sql.identifier(column)})`);

// user / auto / mod の 3 軸。rating は COALESCE(mod, MAX(user, auto, derived)) の生成カラム。
// VIRTUAL なので行には保存されない (インデックスは張れる)
export const ratings = (withDerived: boolean) => ({
  userRating: integer("user_rating").notNull().default(RATINGS.general),
  autoRating: integer("auto_rating"),
  modRating: integer("mod_rating"),
  ...(withDerived ? { derivedRating: integer("derived_rating") } : {}),
  rating: integer("rating").generatedAlwaysAs(
    withDerived
      ? sql`coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0), coalesce(derived_rating, 0)))`
      : sql`coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0)))`,
    { mode: "virtual" },
  ),
});

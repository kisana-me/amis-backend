import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aid, timestamps } from "./columns";

// 本体 accounts の写しと、Amis 独自のアカウント単位の値。
// id は本体の accounts.id をそのまま使う (MVP では開発用の認証が作る)。
// 本体の値で写しを書き換えるときは、Amis 独自のカラムに触れないように列を指定して更新する
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey(),
  aid: aid(),
  name: text("name").notNull(),
  nameId: text("name_id").notNull(),
  iconUrl: text("icon_url"),
  status: integer("status").notNull().default(0),
  visibility: integer("visibility").notNull().default(0),
  adult: integer("adult", { mode: "boolean" }).notNull().default(false),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  // ここから Amis 独自 (本体では accounts.meta の amis_* に入っていた)
  // 登録直後に 1 回だけ渡す別枠 (INITIAL_BONUS)。bonus_granted_at が null なら未付与
  bonusRemaining: integer("bonus_remaining").notNull().default(0),
  bonusGrantedAt: integer("bonus_granted_at", { mode: "timestamp_ms" }),
  // 週の原価上限。0 以下は無制限
  weeklyCostLimitMicro: integer("weekly_cost_limit_micro").notNull().default(0),
  ...timestamps,
}, (t) => [
  uniqueIndex("index_accounts_on_aid").on(t.aid),
  uniqueIndex("index_accounts_on_name_id").on(t.nameId),
]);

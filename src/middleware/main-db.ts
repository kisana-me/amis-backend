import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { mainDb } from "../lib/main-db";

// 本体の DB への接続はリクエストごとに 1 本。使ったときだけつなぎ、レスポンスのあとで閉じる
export const mainDbConnection = createMiddleware<AppEnv>(async (c, next) => {
  const db = mainDb(c.env);
  c.set("mainDb", db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(db.close());
  }
});

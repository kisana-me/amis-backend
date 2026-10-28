import { Hono } from "hono";
import type { AppEnv } from "./env";
import { currentAccount, requireSignin, type SessionSource } from "./middleware/auth";
import { mainDbConnection } from "./middleware/main-db";

export type AppDeps = {
  // テストで本体の DB を差し替える
  sessionSource?: SessionSource;
};

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath("/v1/amis");

  app.use(mainDbConnection, currentAccount(deps.sessionSource));

  app.get("/health", (c) => c.json({ status: "success" }));

  // 認証の確認用。自分のアカウントの最低限の情報だけを返す
  app.get("/session", requireSignin, (c) => {
    const account = c.var.currentAccount!;
    return c.json({
      status: "success",
      account: { aid: account.aid, name: account.name, name_id: account.nameId, icon_url: account.iconUrl },
    });
  });

  app.notFound((c) => c.json({ status: "error", message: "見つかりませんでした" }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ status: "error", message: "サーバーでエラーが発生しました" }, 500);
  });

  return app;
}

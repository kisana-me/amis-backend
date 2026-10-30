import { Hono } from "hono";
import type { AppEnv } from "./env";
import { currentAccount, requireSignin, type SessionSource } from "./middleware/auth";
import { corsPolicy, originCheck } from "./middleware/cors";
import { d1Connection } from "./middleware/db";
import { mainDbConnection } from "./middleware/main-db";
import type { MainDb } from "./lib/main-db";
import { type ImageProcessor, imagesBindingProcessor } from "./media/images";
import type { Bindings } from "./env";
import { characterRoutes } from "./routes/characters";
import { plotRoutes } from "./routes/plots";
import { accountRoutes } from "./routes/accounts";
import { cardRoutes } from "./routes/cards";
import { chatRoutes } from "./routes/chats";
import { messageRoutes } from "./routes/messages";
import { likeRoutes } from "./routes/likes";
import { loreRoutes } from "./routes/lores";
import { mediaRoutes } from "./routes/media";
import { personaRoutes } from "./routes/personas";
import { reportRoutes } from "./routes/reports";
import { modelRoutes } from "./routes/models";
import { quotaRoutes } from "./routes/quota";

export type AppDeps = {
  // テストで本体の DB を差し替える
  mainDb?: (env: Bindings) => MainDb;
  // テストで画像の変換 (Images バインディング) を差し替える
  imageProcessor?: ImageProcessor;
  sessionSource?: SessionSource;
};

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath("/v1/amis");

  // セッションも DB も要らないので、共通のミドルウェアより前に置く
  app.route("/", mediaRoutes);

  app.use(corsPolicy, originCheck, d1Connection, mainDbConnection(deps.mainDb), currentAccount(deps.sessionSource));

  app.get("/health", (c) => c.json({ status: "success" }));

  // 認証の確認用。自分のアカウントの最低限の情報だけを返す
  app.get("/session", requireSignin, (c) => {
    const account = c.var.currentAccount!;
    return c.json({
      status: "success",
      account: { aid: account.aid, name: account.name, name_id: account.nameId, icon_url: account.iconUrl },
    });
  });

  app.use(async (c, next) => {
    c.set("imageProcessor", deps.imageProcessor ?? imagesBindingProcessor(c.env.IMAGES));
    await next();
  });

  app.route("/", quotaRoutes);
  app.route("/", modelRoutes);
  app.route("/", characterRoutes);
  app.route("/", plotRoutes);
  app.route("/", accountRoutes);
  app.route("/", cardRoutes);
  app.route("/", loreRoutes);
  app.route("/", personaRoutes);
  app.route("/", likeRoutes);
  app.route("/", chatRoutes);
  app.route("/", messageRoutes);
  app.route("/", reportRoutes);

  app.notFound((c) => c.json({ status: "error", message: "見つかりませんでした" }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ status: "error", message: "サーバーでエラーが発生しました" }, 500);
  });

  return app;
}

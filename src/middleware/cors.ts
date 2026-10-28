import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { COOKIE_NAME } from "../auth/tokens";
import type { AppEnv, Bindings } from "../env";

export function allowedOrigins(env: Pick<Bindings, "ALLOWED_ORIGINS">): string[] {
  return env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
}

// 本体の config/initializers/cors.rb と同じ設定 (Cookie を送れるように credentials を付ける)
export const corsPolicy = createMiddleware<AppEnv>((c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    exposeHeaders: ["X-Next-Cursor"],
    credentials: true,
  })(c, next),
);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// 本体の CSRF トークンは Rails のセッションに結びついていて使えないので、Origin で確かめる。
// Cookie で認証されうるリクエストだけが対象。Cookie を持たない Bearer (ネイティブアプリ) は通す。
// 本体と違って 419 は返さない (フロントがトークンを取り直して再送しても通らないため)
export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || getCookie(c, COOKIE_NAME) === undefined) return next();

  const origin = c.req.header("Origin");
  if (!origin || !allowedOrigins(c.env).includes(origin)) {
    return c.json({ status: "error", message: "許可されていないオリジンからのリクエストです" }, 403);
  }
  await next();
});

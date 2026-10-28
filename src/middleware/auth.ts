import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { type FindSessions, findSessionsIn, resolveCurrentAccount } from "../auth/current-account";
import { COOKIE_NAME, extractTokens } from "../auth/tokens";
import type { AppEnv } from "../env";

export type SessionSource = (c: Context<AppEnv>) => FindSessions;

const fromMainDb: SessionSource = (c) => findSessionsIn(c.var.mainDb);

// 本体の before_action :current_account と同じく、すべてのリクエストで今のアカウントを決める。
// トークンがなければ DB には問い合わせない
export const currentAccount = (source: SessionSource = fromMainDb) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const tokens = extractTokens(getCookie(c, COOKIE_NAME), c.req.header("Authorization"));
    const resolved = await resolveCurrentAccount(tokens, source(c), c.env);
    c.set("currentAccount", resolved?.account ?? null);
    c.set("currentSession", resolved?.session ?? null);
    await next();
  });

// 本体の V1::ApplicationController#require_signin と同じレスポンス
export const requireSignin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.currentAccount) {
    return c.json({ status: "error", message: "サインインしてください" }, 401);
  }
  await next();
});

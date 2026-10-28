import { createMiddleware } from "hono/factory";
import { d1 } from "../db/client";
import type { AppEnv } from "../env";

export const d1Connection = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", d1(c.env.DB));
  await next();
});

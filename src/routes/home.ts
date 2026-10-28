import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { plots } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { visiblePlots } from "../queries/visibility";
import { loadContext, loadersOf } from "../views/context";
import { plotJson } from "../views/json";

const LIMIT = 20;

export const homeRoutes = new Hono<AppEnv>();

// トップはプロット一覧だけ (本体の home#index)。タブで並び順を変える
homeRoutes.post("/home", async (c) => {
  const body = await jsonBody(c);
  const tab = typeof body.tab === "string" && body.tab ? body.tab : "popular";
  const order =
    tab === "new" ? [desc(plots.id)]
    : tab === "trending" ? [desc(plots.chatsCount), desc(plots.id)]
    // 完結数がランキングの主指標
    : [desc(plots.clearsCount), desc(plots.chatsCount), desc(plots.id)];

  const rows = await c.var.db.select().from(plots)
    .where(visiblePlots(maxRatingFor(c.var.currentAccount))).orderBy(...order).limit(LIMIT);
  const ctx = await loadContext(loadersOf(c), { plots: rows });
  return c.json({ status: "success", plots: rows.map((p) => plotJson(p, ctx)) });
});

import { and, desc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { ACCOUNT_STATUSES, findAccountByNameId } from "../accounts/accounts";
import { CONTENT_STATUSES, characters, plots, VISIBILITIES } from "../db/schema";
import type { AppEnv } from "../env";
import { notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { visibleCharacters, visiblePlots } from "../queries/visibility";
import { loadContext, loadersOf } from "../views/context";
import { characterJson, plotJson, visibilityLabel } from "../views/json";

const LIMIT = 50;

export const accountRoutes = new Hono<AppEnv>();

// アカウントの Amis のページ (本体の accounts#show)。本人には非公開のぶんも返す。
// 結末の収集 (achievements) は廃止したので、常に空で返す
accountRoutes.post("/accounts/:handle{@.+}", async (c) => {
  const account = await findAccountByNameId(c.var.mainDb, c.env, c.req.param("handle").slice(1));
  if (!account || account.status !== ACCOUNT_STATUSES.normal || account.visibility !== VISIBILITIES.opened) {
    return notFound(c, "アカウントが見つかりませんでした");
  }

  const viewer = c.var.currentAccount;
  const mine = viewer !== null && viewer.id === account.id;
  const maxRating = maxRatingFor(viewer);
  const [plotRows, characterRows] = await Promise.all([
    c.var.db.select().from(plots)
      .where(and(eq(plots.authorId, account.id), mine ? ne(plots.status, CONTENT_STATUSES.deleted) : visiblePlots(maxRating)))
      .orderBy(desc(plots.id)).limit(LIMIT),
    c.var.db.select().from(characters)
      .where(and(eq(characters.authorId, account.id), mine ? ne(characters.status, CONTENT_STATUSES.deleted) : visibleCharacters(maxRating)))
      .orderBy(desc(characters.id)).limit(LIMIT),
  ]);
  const ctx = await loadContext(loadersOf(c), { plots: plotRows, characters: characterRows });

  return c.json({
    status: "success",
    mine,
    plots: plotRows.map((p) => ({ ...plotJson(p, ctx), ...(mine ? { visibility: visibilityLabel(p.visibility) } : {}) })),
    characters: characterRows.map((ch) => ({ ...characterJson(ch, ctx), ...(mine ? { visibility: visibilityLabel(ch.visibility) } : {}) })),
    achievements: [],
  });
});

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { characters, plots } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody, notFound } from "../lib/http";
import { maxRatingFor } from "../lib/ratings";
import { visibleCharacters, visiblePlots } from "../queries/visibility";
import { loadContext, loadersOf } from "../views/context";
import { linkCardJson } from "../views/json";

export const cardRoutes = new Hono<AppEnv>();

// 投稿に貼られた Amis のリンクを、フロントがカードにするために引く (本体の cards#show)
cardRoutes.post("/cards", async (c) => {
  const body = await jsonBody(c);
  const aid = typeof body.aid === "string" ? body.aid : "";
  const maxRating = maxRatingFor(c.var.currentAccount);

  if (body.type === "plot") {
    const [plot] = await c.var.db.select().from(plots).where(and(eq(plots.aid, aid), visiblePlots(maxRating))).limit(1);
    if (!plot) return notFound(c, "見つかりませんでした");
    const ctx = await loadContext(loadersOf(c), { plots: [plot], casts: new Map() });
    return c.json({ card: linkCardJson({ kind: "plot", row: plot }, ctx) });
  }
  if (body.type === "character") {
    const [character] = await c.var.db.select().from(characters).where(and(eq(characters.aid, aid), visibleCharacters(maxRating))).limit(1);
    if (!character) return notFound(c, "見つかりませんでした");
    const ctx = await loadContext(loadersOf(c), { characters: [character] });
    return c.json({ card: linkCardJson({ kind: "character", row: character }, ctx) });
  }
  return notFound(c, "見つかりませんでした");
});

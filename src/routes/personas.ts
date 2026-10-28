import { and, asc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { CONTENT_STATUSES, personas } from "../db/schema";
import type { AppEnv } from "../env";
import { requireSignin } from "../middleware/auth";
import { loadContext, loadersOf } from "../views/context";
import { personaJson } from "../views/json";

export const personaRoutes = new Hono<AppEnv>();

// 自分のペルソナ (本体の personas#index)
personaRoutes.post("/personas", requireSignin, async (c) => {
  const rows = await c.var.db.select().from(personas)
    .where(and(ne(personas.status, CONTENT_STATUSES.deleted), eq(personas.accountId, c.var.currentAccount!.id)))
    .orderBy(asc(personas.position), asc(personas.id));
  const ctx = await loadContext(loadersOf(c), { imageIds: rows.map((p) => p.iconId).filter((id): id is number => id !== null) });
  return c.json({ status: "success", personas: rows.map((p) => personaJson(p, ctx)) });
});

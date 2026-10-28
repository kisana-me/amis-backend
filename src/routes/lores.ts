import { and, desc, eq, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { CONTENT_STATUSES, lores, VISIBILITIES } from "../db/schema";
import type { AppEnv } from "../env";
import { jsonBody, notFound } from "../lib/http";
import { requireSignin } from "../middleware/auth";
import { containing, entriesOf, loreBodyLengths } from "../queries/related";
import { loadContext, loadersOf } from "../views/context";
import { editableLoreJson, loreJson } from "../views/json";

const LIMIT = 100;
const SELECTABLE_LIMIT = 100;

export const loreRoutes = new Hono<AppEnv>();

const ownLores = (accountId: number) => and(ne(lores.status, CONTENT_STATUSES.deleted), eq(lores.authorId, accountId));

// 自分の設定集 (本体の lores#index)
loreRoutes.post("/lores", requireSignin, async (c) => {
  const viewer = c.var.currentAccount!;
  const rows = await c.var.db.select().from(lores).where(ownLores(viewer.id)).orderBy(desc(lores.id)).limit(LIMIT);
  const [ctx, lengths] = await Promise.all([
    loadContext(loadersOf(c), { lores: rows }),
    loreBodyLengths(c.var.db, rows.map((l) => l.id)),
  ]);
  return c.json({ status: "success", lores: rows.map((l) => loreJson(l, ctx, viewer.id, lengths.get(l.id) ?? 0)) });
});

// プロットに付けられる設定集。自分のもの (非公開も) を先頭に、他人の公開 + 付けてよいものを後ろに
loreRoutes.post("/lores/selectable", requireSignin, async (c) => {
  const viewer = c.var.currentAccount!;
  const query = String((await jsonBody(c)).q ?? "").trim();
  const search = query ? containing(lores.title, query) : undefined;
  const attachable = and(eq(lores.status, CONTENT_STATUSES.normal), eq(lores.visibility, VISIBILITIES.opened), eq(lores.allowAttach, true));

  const [mine, others] = await Promise.all([
    c.var.db.select().from(lores).where(and(ownLores(viewer.id), search)).orderBy(desc(lores.id)).limit(SELECTABLE_LIMIT),
    c.var.db.select().from(lores).where(and(attachable, ne(lores.authorId, viewer.id), search))
      .orderBy(desc(lores.plotsCount), desc(lores.id)).limit(SELECTABLE_LIMIT),
  ]);
  const [ctx, lengths] = await Promise.all([
    loadContext(loadersOf(c), { lores: [...mine, ...others] }),
    loreBodyLengths(c.var.db, [...mine, ...others].map((l) => l.id)),
  ]);
  const json = (l: (typeof mine)[number]) => loreJson(l, ctx, viewer.id, lengths.get(l.id) ?? 0);
  return c.json({ status: "success", mine: mine.map(json), others: others.map(json) });
});

// 項目まで返す。自分のものと、公開されているものは誰でも読める
loreRoutes.post("/lores/:aid", async (c) => {
  const viewerId = c.var.currentAccount?.id ?? null;
  const readable = or(
    and(eq(lores.status, CONTENT_STATUSES.normal), eq(lores.visibility, VISIBILITIES.opened)),
    viewerId === null ? undefined : eq(lores.authorId, viewerId),
  );
  const [lore] = await c.var.db.select().from(lores)
    .where(and(eq(lores.aid, c.req.param("aid")), ne(lores.status, CONTENT_STATUSES.deleted), readable)).limit(1);
  if (!lore) return notFound(c, "設定集が見つかりませんでした");

  const [ctx, entries] = await Promise.all([loadContext(loadersOf(c), { lores: [lore] }), entriesOf(c.var.db, [lore.id])]);
  return c.json({ status: "success", lore: editableLoreJson(lore, entries.get(lore.id) ?? [], ctx, viewerId) });
});

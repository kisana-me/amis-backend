import { and, asc, count, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { CONTENT_STATUSES, personas } from "../db/schema";
import type { AppEnv } from "../env";
import { ValidationErrors } from "../lib/errors";
import { newAid } from "../lib/aid";
import { notFound } from "../lib/http";
import { readForm } from "../lib/form";
import { requireSignin } from "../middleware/auth";
import { bool, optionalText, requiredText } from "../writers/common";
import { loadContext, loadersOf, type Persona } from "../views/context";
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

const MAX_PERSONAS = 5;

const ownPersonas = (accountId: number) => and(ne(personas.status, CONTENT_STATUSES.deleted), eq(personas.accountId, accountId));

// 本体の personas/show.json.jbuilder
async function personaShow(c: Parameters<typeof loadersOf>[0], persona: Persona) {
  const ctx = await loadContext(loadersOf(c), { imageIds: persona.iconId === null ? [] : [persona.iconId] });
  return { status: "success", persona: personaJson(persona, ctx) };
}

// 名前と説明 (と既定・順序) を読む。渡ってきたキーだけを返す
async function personaValues(c: Parameters<typeof readForm>[0], current?: Persona) {
  const form = await readForm(c);
  const errors = new ValidationErrors();
  const values: Partial<typeof personas.$inferInsert> = {};
  if (form.has("name")) values.name = form.get("name") ?? "";
  if (form.has("description")) values.description = form.get("description") ?? "";
  if (form.has("is_default")) values.isDefault = bool(form.get("is_default"));
  if (form.has("position")) values.position = Math.trunc(Number(form.get("position")) || 0);
  requiredText(errors, "名前", values.name ?? current?.name ?? "", 50);
  // 毎ターン system プロンプトに載る
  optionalText(errors, "説明", values.description ?? current?.description ?? "", 2000);
  return { values, errors };
}

personaRoutes.post("/personas/create", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const [{ n }] = await db.select({ n: count() }).from(personas).where(ownPersonas(account.id));
  if (n >= MAX_PERSONAS) return c.json({ status: "error", message: `ペルソナは${MAX_PERSONAS}件までです` }, 422);

  const { values, errors } = await personaValues(c);
  if (errors.any) return c.json({ status: "error", message: errors.toSentence() }, 422);
  const [persona] = await db.insert(personas).values({ name: "", ...values, aid: newAid(), accountId: account.id }).returning();
  return c.json(await personaShow(c, persona));
});

personaRoutes.patch("/personas/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const [persona] = await db.select().from(personas)
    .where(and(ownPersonas(c.var.currentAccount!.id), eq(personas.aid, c.req.param("aid")))).limit(1);
  if (!persona) return notFound(c, "ペルソナが見つかりませんでした");

  const { values, errors } = await personaValues(c, persona);
  if (errors.any) return c.json({ status: "error", message: errors.toSentence() }, 422);
  const [updated] = Object.keys(values).length > 0
    ? await db.update(personas).set(values).where(eq(personas.id, persona.id)).returning()
    : [persona];
  return c.json(await personaShow(c, updated));
});

// チャットが参照しているのでソフトデリート
personaRoutes.delete("/personas/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const [persona] = await db.select().from(personas)
    .where(and(ownPersonas(c.var.currentAccount!.id), eq(personas.aid, c.req.param("aid")))).limit(1);
  if (!persona) return notFound(c, "ペルソナが見つかりませんでした");
  await db.update(personas).set({ status: CONTENT_STATUSES.deleted }).where(eq(personas.id, persona.id));
  return c.json({ status: "success" });
});

import { and, count, desc, eq, ne, notInArray, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "../db/client";
import { Hono } from "hono";
import { CONTENT_STATUSES, loreEntries, lores, plotLores, VISIBILITIES } from "../db/schema";
import { keywordList } from "../generation/lore-matcher";
import { charLength, isBlank } from "../generation/ruby-text";
import { newAid } from "../lib/aid";
import { ValidationErrors } from "../lib/errors";
import { readForm } from "../lib/form";
import type { AppEnv } from "../env";
import { jsonBody, notFound } from "../lib/http";
import { requireSignin } from "../middleware/auth";
import { bool, enumValue, normalizeNewlines, optionalText, parseJsonRows, requiredText, VISIBILITY_KEYS } from "../writers/common";
import { containing, entriesOf, loreBodyLengths } from "../queries/related";
import { loadContext, loadersOf, type Lore } from "../views/context";
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
loreRoutes.post("/lores/:aid{[a-z0-9]{14}}", async (c) => {
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

const MAX_LORES = 50;
// 1 冊あたりの項目数。画面で一度に扱える数と、作者が把握できる数の上限として置く
const MAX_ENTRIES = 50;
const MAX_KEYWORD_LENGTH = 20;
const MAX_KEYWORDS = 5;

type EntryRow = { id: number | null; title: string; keywords: string; body: string };

// 設定集 + 項目を読んで検証する (本体の LoreWriter と Lore / LoreEntry のバリデーション)
async function loreValues(c: Context<AppEnv>, current?: Lore) {
  const form = await readForm(c, "lore");
  const errors = new ValidationErrors();
  const values: Partial<typeof lores.$inferInsert> = {};
  if (form.has("title")) values.title = form.get("title") ?? "";
  if (form.has("description")) values.description = normalizeNewlines(form.get("description") ?? "");
  if (form.has("allow_attach")) values.allowAttach = bool(form.get("allow_attach"));
  if (form.has("visibility")) values.visibility = enumValue(errors, "公開状態", VISIBILITY_KEYS, form.get("visibility"));
  requiredText(errors, "タイトル", values.title ?? current?.title ?? "", 100);
  optionalText(errors, "説明", values.description ?? current?.description ?? "", 2000);

  // 送られてこなければ項目には触らない
  const rows = parseJsonRows(errors, "項目", form.get("entries_json"));
  const entries: EntryRow[] | null = rows && rows.map((row) => ({
    id: Number.isFinite(Number(row.id)) && row.id !== null && row.id !== "" ? Math.trunc(Number(row.id)) : null,
    title: String(row.title ?? ""),
    // 「、、、」や前後の空白のような、区切りだけの入力はここで落とす。保存されるのは読点 1 つ区切りの並び
    keywords: keywordList(String(row.keywords ?? "")).join("、"),
    body: normalizeNewlines(String(row.body ?? "")),
  }));
  if (entries && entries.length > MAX_ENTRIES) errors.add(`項目は${MAX_ENTRIES}個までです`);
  else entries?.forEach((entry) => validateEntry(errors, entry));
  return { values, entries, errors };
}

function validateEntry(errors: ValidationErrors, entry: EntryRow) {
  const sub = new ValidationErrors();
  optionalText(sub, "見出し", entry.title, 50);
  if (isBlank(entry.keywords)) sub.blank("キーワード");
  else {
    optionalText(sub, "キーワード", entry.keywords, 200);
    const words = keywordList(entry.keywords);
    if (words.length > MAX_KEYWORDS) sub.add(`キーワードは${MAX_KEYWORDS}つまでです`);
    const long = words.filter((word) => charLength(word) > MAX_KEYWORD_LENGTH);
    if (long.length > 0) sub.add(`キーワードは1つ${MAX_KEYWORD_LENGTH}文字までです (${long.join(" / ")})`);
  }
  if (isBlank(entry.body)) sub.blank("本文");
  for (const message of sub.messages) errors.add(`項目: ${message}`);
}

// 項目を同期する。送られた id のうち、この設定集のものは書き換え、無いものは足し、残らなかったものは消す
async function entryStatements(db: Db, loreAid: string, loreId: number | null, entries: EntryRow[]) {
  const existing = loreId === null ? [] : await db.select({ id: loreEntries.id }).from(loreEntries).where(eq(loreEntries.loreId, loreId));
  const existingIds = new Set(existing.map((e) => e.id));
  const kept = entries.filter((e) => e.id !== null && existingIds.has(e.id)).map((e) => e.id!);
  const loreRef = sql`(SELECT ${lores.id} FROM ${lores} WHERE ${lores.aid} = ${loreAid})`;
  return [
    ...(loreId === null ? [] : [db.delete(loreEntries).where(and(eq(loreEntries.loreId, loreId), kept.length > 0 ? notInArray(loreEntries.id, kept) : undefined))]),
    ...entries.map((entry) =>
      entry.id !== null && existingIds.has(entry.id)
        ? db.update(loreEntries).set({ title: entry.title, keywords: entry.keywords, body: entry.body }).where(eq(loreEntries.id, entry.id))
        : db.insert(loreEntries).values({ loreId: loreRef as unknown as number, title: entry.title, keywords: entry.keywords, body: entry.body })),
    db.update(lores).set({ entriesCount: sql`(SELECT COUNT(*) FROM ${loreEntries} WHERE ${loreEntries.loreId} = ${lores.id})` }).where(eq(lores.aid, loreAid)),
  ];
}

async function loreShow(c: Context<AppEnv>, aid: string) {
  const [lore] = await c.var.db.select().from(lores).where(eq(lores.aid, aid)).limit(1);
  const [ctx, entries] = await Promise.all([loadContext(loadersOf(c), { lores: [lore] }), entriesOf(c.var.db, [lore.id])]);
  return { status: "success", lore: editableLoreJson(lore, entries.get(lore.id) ?? [], ctx, c.var.currentAccount?.id ?? null) };
}

loreRoutes.post("/lores/create", requireSignin, async (c) => {
  const { db } = c.var;
  const account = c.var.currentAccount!;
  const [{ n }] = await db.select({ n: count() }).from(lores).where(ownLores(account.id));
  if (n >= MAX_LORES) return c.json({ status: "error", message: `設定集は${MAX_LORES}冊までです` }, 422);

  const { values, entries, errors } = await loreValues(c);
  if (errors.any) return c.json({ status: "error", message: errors.toSentence() }, 422);
  const aid = newAid();
  await db.batch([
    db.insert(lores).values({ title: "", ...values, aid, authorId: account.id }),
    ...(await entryStatements(db, aid, null, entries ?? [])),
  ]);
  return c.json(await loreShow(c, aid));
});

loreRoutes.patch("/lores/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const [lore] = await db.select().from(lores).where(and(ownLores(c.var.currentAccount!.id), eq(lores.aid, c.req.param("aid")))).limit(1);
  if (!lore) return notFound(c, "設定集が見つかりませんでした");

  const { values, entries, errors } = await loreValues(c, lore);
  if (errors.any) return c.json({ status: "error", message: errors.toSentence() }, 422);
  await db.batch([
    db.update(lores).set({ ...values, updatedAt: new Date() }).where(eq(lores.id, lore.id)),
    ...(entries ? await entryStatements(db, lore.aid, lore.id, entries) : []),
  ]);
  return c.json(await loreShow(c, lore.aid));
});

// プロットが参照しているのでソフトデリート。付いていたプロットからは外れ、進行中のチャットには次のターンから載らない
loreRoutes.delete("/lores/:aid", requireSignin, async (c) => {
  const { db } = c.var;
  const [lore] = await db.select().from(lores).where(and(ownLores(c.var.currentAccount!.id), eq(lores.aid, c.req.param("aid")))).limit(1);
  if (!lore) return notFound(c, "設定集が見つかりませんでした");
  await db.batch([
    db.delete(plotLores).where(eq(plotLores.loreId, lore.id)),
    db.update(lores).set({ status: CONTENT_STATUSES.deleted, plotsCount: 0 }).where(eq(lores.id, lore.id)),
  ]);
  return c.json({ status: "success" });
});

// キャラとプロットへの通報 (本体の V1::ReportsController#create の Amis の分)。未サインインでも受け付ける
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { CONTENT_STATUSES, characters, plots, REPORT_CATEGORIES, reports, VISIBILITIES } from "../db/schema";
import type { AppEnv } from "../env";
import { charLength, isBlank } from "../generation/ruby-text";
import { newAid } from "../lib/aid";
import { readForm } from "../lib/form";

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.post("/reports", async (c) => {
  const { db } = c.var;
  const form = await readForm(c, "report");
  const targetType = form.get("target_type") ?? "";
  const targetAid = form.get("target_aid") ?? "";
  const categoryKey = form.get("category") ?? "other";
  const description = form.get("description") ?? "";
  const errors: string[] = [];

  // 限定公開はリンクを踏めば読めるので通報も通す (完全非公開の closed だけ弾く)
  const visible = <T extends typeof characters | typeof plots>(table: T) =>
    and(eq(table.aid, targetAid), eq(table.status, CONTENT_STATUSES.normal), ne(table.visibility, VISIBILITIES.closed));
  let targetId: number | undefined;
  if (targetType === "amis_character") {
    [{ id: targetId } = { id: undefined }] = await db.select({ id: characters.id }).from(characters).where(visible(characters)).limit(1);
    if (targetId === undefined) errors.push("通報対象のキャラが見つかりませんでした");
  } else if (targetType === "amis_plot") {
    [{ id: targetId } = { id: undefined }] = await db.select({ id: plots.id }).from(plots).where(visible(plots)).limit(1);
    if (targetId === undefined) errors.push("通報対象のプロットが見つかりませんでした");
  } else {
    errors.push("通報対象が見つかりませんでした");
  }
  if (!(categoryKey in REPORT_CATEGORIES)) errors.push("種類は一覧にありません");
  if (!isBlank(description) && charLength(description) > 1000) errors.push("詳細は1000文字以内で入力してください");

  if (errors.length > 0 || targetId === undefined) {
    return c.json({ status: "error", message: "通報できませんでした", errors }, 422);
  }
  await db.insert(reports).values({
    aid: newAid(), accountId: c.var.currentAccount?.id ?? null, targetType, targetId,
    category: REPORT_CATEGORIES[categoryKey as keyof typeof REPORT_CATEGORIES], description,
  });
  return c.json({ status: "success", message: "通報しました" }, 201);
});

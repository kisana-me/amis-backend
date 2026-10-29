import type { Context } from "hono";

// 本体の render_not_found と同じ形
export function notFound(c: Context, message: string) {
  return c.json({ status: "error", message }, 404);
}

// フロントは一覧や詳細も POST で取り、条件を JSON の本文で送る。本文がなくても通す
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

// 一覧の並び順。知らない値や省略は先頭のものにする
export function sortParam<T extends string>(value: unknown, sorts: readonly [T, ...T[]]): T {
  return sorts.find((s) => s === value) ?? sorts[0];
}

// 一覧の件数。1〜max に収め、数でなければ fallback
export function limitParam(value: unknown, fallback: number, max = 100): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

// 一覧の検索語。前後の空白は落とす
export const queryParam = (value: unknown) => (typeof value === "string" ? value.trim() : "");

// ActiveModel::Type::Boolean と同じ。空なら null、偽を表す値以外はすべて真
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
export function castBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return !FALSE_VALUES.has(value);
}

// 本体の Time.current.iso8601 と同じく、JST のオフセット付きで書く (2026-10-28T17:00:00+09:00)
export function jstIso8601(date = new Date()): string {
  return `${new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`;
}

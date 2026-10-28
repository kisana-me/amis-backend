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

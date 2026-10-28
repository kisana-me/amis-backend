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

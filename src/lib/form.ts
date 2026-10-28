// 書き込みの本文を読む。フロントはキャラとプロットを Rails 形式のキー (character[name]、character[images_files][]) の
// multipart で、ロアは { lore: {...} } の JSON で、ペルソナは平らな JSON で送ってくる。どれも同じ読み方にそろえる
import type { Context } from "hono";

export type FormReader = {
  has(key: string): boolean;
  // 文字列の値。無ければ null
  get(key: string): string | null;
  files(key: string): File[];
};

export async function readForm(c: Context, scope?: string): Promise<FormReader> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    const name = (key: string) => (scope ? `${scope}[${key}]` : key);
    return {
      has: (key) => form.has(name(key)),
      get: (key) => {
        const value = form.get(name(key));
        return typeof value === "string" ? value : null;
      },
      files: (key) => [...form.getAll(name(key)), ...form.getAll(`${name(key)}[]`)].filter((v): v is File => typeof v !== "string"),
    };
  }

  const body = await c.req.json().catch(() => ({}));
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const values = (scope && typeof root[scope] === "object" && root[scope] !== null ? root[scope] : root) as Record<string, unknown>;
  return {
    has: (key) => key in values,
    get: (key) => {
      const value = values[key];
      if (value === null || value === undefined) return null;
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    },
    files: () => [],
  };
}

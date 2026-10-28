import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function d1(database: D1Database) {
  return drizzle(database, { schema });
}

export type Db = ReturnType<typeof d1>;

// D1 は 1 回のクエリにバインドできる値が 100 個まで。IN に渡す id は分けて引く
const CHUNK = 90;

export async function inChunks<T, R>(values: T[], run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const unique = [...new Set(values)];
  const results: R[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    results.push(...(await run(unique.slice(i, i + CHUNK))));
  }
  return results;
}

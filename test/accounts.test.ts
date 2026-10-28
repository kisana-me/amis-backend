import { describe, expect, it } from "vitest";
import { type AccountRow, authorJson, findAccountByNameId, findAccountsByIds } from "../src/accounts/accounts";
import type { MainDb } from "../src/lib/main-db";

const env = { S3_PUBLIC_ENDPOINT: "https://media.example.test", BACK_URL: "https://api.example.test" };

const row = (id: number, overrides: Partial<AccountRow> = {}): AccountRow => ({
  account_id: id, account_aid: `aid${id}`, name: `name${id}`, name_id: `nameid${id}`, status: 0, visibility: 0,
  adult: 0, admin: 0, icon_aid: null, icon_status: null, icon_variant_type: null, icon_rating: null, ...overrides,
});

function fakeDb(rows: AccountRow[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: MainDb = {
    query: async <T>(sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return rows as T[];
    },
    close: async () => undefined,
  };
  return { db, calls };
}

describe("findAccountsByIds", () => {
  it("重複を除いて 1 本で引き、id で引ける Map を返す", async () => {
    const { db, calls } = fakeDb([row(1), row(2)]);
    const accounts = await findAccountsByIds(db, env, [1, 2, 1]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params[1]).toEqual([1, 2]);
    expect(accounts.get(2)?.nameId).toBe("nameid2");
  });

  it("id がなければ問い合わせない", async () => {
    const { db, calls } = fakeDb([]);
    expect((await findAccountsByIds(db, env, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("findAccountByNameId", () => {
  it("見つからなければ null", async () => {
    const { db } = fakeDb([]);
    expect(await findAccountByNameId(db, env, "nobody")).toBeNull();
  });
});

describe("authorJson", () => {
  it("本体の _author.json.jbuilder と同じ形", async () => {
    const { db } = fakeDb([row(1, { icon_aid: "icon", icon_status: 0, icon_variant_type: "webp", icon_rating: 0 })]);
    const account = (await findAccountsByIds(db, env, [1])).get(1);
    expect(authorJson(account)).toEqual({ name: "name1", name_id: "nameid1", icon_url: "https://media.example.test/images/variants/icon.webp" });
    expect(authorJson(undefined)).toBeNull();
  });
});

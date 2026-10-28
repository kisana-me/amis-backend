import { env } from "cloudflare:workers";
import type { AccountRow } from "../src/accounts/accounts";
import { createApp } from "../src/app";
import type { SessionRow } from "../src/auth/current-account";
import { tokenLookup } from "../src/auth/tokens";
import { d1 } from "../src/db/client";
import * as schema from "../src/db/schema";
import type { MainDb } from "../src/lib/main-db";

export const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
export const db = () => d1(env.DB);

let seq = 0;
export const uid = (prefix: string) => `${prefix}${String(++seq).padStart(14 - prefix.length, "0")}`;

export function accountRow(id: number, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    account_id: id, account_aid: `acc${id}`, name: `なまえ${id}`, name_id: `user${id}`, status: 0, visibility: 0,
    adult: 1, admin: 0, icon_aid: null, icon_status: null, icon_variant_type: null, icon_rating: null, ...overrides,
  };
}

// 本体の DB の代わり。SQL の FROM を見て sessions か accounts の行を返す
export function fakeMainDb(accounts: AccountRow[], sessions: { token: string; accountId: number }[] = []): MainDb {
  return {
    async query<T>(sql: string, params: unknown[]) {
      if (sql.includes("FROM sessions")) {
        const lookups = params[1] as string[];
        const rows: SessionRow[] = [];
        for (const s of sessions) {
          const lookup = await tokenLookup(s.token);
          const account = accounts.find((a) => a.account_id === s.accountId);
          if (account && lookups.includes(lookup)) rows.push({ ...account, token_lookup: lookup, session_id: 1, session_aid: "sess" });
        }
        return rows as T[];
      }
      if (sql.includes("a.id IN")) return accounts.filter((a) => (params[1] as number[]).includes(a.account_id)) as T[];
      if (sql.includes("a.name_id =")) return accounts.filter((a) => a.name_id === params[1]) as T[];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    close: async () => undefined,
  };
}

// accounts のうち、token を持つ人はサインインできる
export function appWith(accounts: AccountRow[], sessions: { token: string; accountId: number }[] = []) {
  const app = createApp({ mainDb: () => fakeMainDb(accounts, sessions) });
  return {
    post: (path: string, opts: { token?: string; body?: unknown } = {}) =>
      app.request(`/v1/amis${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify(opts.body ?? {}),
      }, env, ctx),
  };
}

export async function insertCharacter(values: Partial<typeof schema.characters.$inferInsert> = {}) {
  const [row] = await db().insert(schema.characters)
    .values({ aid: uid("ch"), name: "キャラ", persona: "定義", authorId: 1, ...values }).returning();
  return row;
}

export async function insertPlot(values: Partial<typeof schema.plots.$inferInsert> = {}) {
  const [row] = await db().insert(schema.plots).values({ aid: uid("pl"), title: "プロット", authorId: 1, ...values }).returning();
  return row;
}

export async function insertImage(values: Partial<typeof schema.images.$inferInsert> = {}) {
  const [row] = await db().insert(schema.images).values({ aid: uid("im"), variantType: "amis-character", ...values }).returning();
  return row;
}

export async function cast(plotId: number, characterId: number, values: Partial<typeof schema.plotCharacters.$inferInsert> = {}) {
  await db().insert(schema.plotCharacters).values({ plotId, characterId, speakerKey: `s${characterId}`, ...values });
}

export async function insertAiModel(values: Partial<typeof schema.aiModels.$inferInsert> = {}) {
  const [row] = await db().insert(schema.aiModels)
    .values({ aid: uid("md"), name: "モデル", provider: "mock", upstreamModel: "mock", ...values }).returning();
  return row;
}

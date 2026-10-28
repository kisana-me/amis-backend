import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { SessionRow } from "../src/auth/current-account";
import { tokenLookup } from "../src/auth/tokens";

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

async function appWith(token: string) {
  const row: SessionRow = {
    token_lookup: await tokenLookup(token), session_id: 1, session_aid: "s", account_id: 1, account_aid: "acc",
    name: "なまえ", name_id: "nameid", status: 0, visibility: 0, adult: 1, admin: 0,
    icon_aid: null, icon_status: null, icon_variant_type: null, icon_rating: null,
  };
  return createApp({ sessionSource: () => async (lookups) => (lookups.includes(row.token_lookup) ? [row] : []) });
}

describe("認証", () => {
  it("Cookie で今のアカウントが返る", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/session", { headers: { Cookie: "amiverse=badtoken.goodtoken" } }, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "success", account: { aid: "acc", name_id: "nameid" } });
  });

  it("Bearer でも通る", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/session", { headers: { Authorization: "Bearer goodtoken" } }, env, ctx);
    expect(res.status).toBe(200);
  });

  it("サインインしていなければ本体と同じ 401", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/session", {}, env, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ status: "error", message: "サインインしてください" });
  });

  it("サインインがいらないエンドポイントは通る", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/health", {}, env, ctx);
    expect(await res.json()).toEqual({ status: "success" });
  });
});

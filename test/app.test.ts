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

describe("CORS と Origin の確認", () => {
  it("許可したオリジンのプリフライトには credentials 付きで答える", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    }, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("許可していないオリジンには Allow-Origin を返さない", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/health", { headers: { Origin: "https://evil.example.test" } }, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Cookie 付きの POST は、Origin が許可したものでなければ 403", async () => {
    const app = await appWith("goodtoken");
    for (const headers of [
      { Cookie: "amiverse=goodtoken" },
      { Cookie: "amiverse=goodtoken", Origin: "https://evil.example.test" },
    ] as Record<string, string>[]) {
      const res = await app.request("/v1/amis/health", { method: "POST", headers }, env, ctx);
      expect(res.status).toBe(403);
    }
  });

  it("Cookie 付きの POST でも、許可したオリジンなら通る", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/session", {
      method: "POST", headers: { Cookie: "amiverse=goodtoken", Origin: "https://front.example.test" },
    }, env, ctx);
    // /session は GET だけなので 404。403 で止まっていないことを見る
    expect(res.status).toBe(404);
  });

  it("Cookie を持たない Bearer の POST は Origin を見ない", async () => {
    const app = await appWith("goodtoken");
    const res = await app.request("/v1/amis/session", { method: "POST", headers: { Authorization: "Bearer goodtoken" } }, env, ctx);
    expect(res.status).toBe(404);
  });
});

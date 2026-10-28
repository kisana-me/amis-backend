import { describe, expect, it } from "vitest";
import { type FindSessions, resolveCurrentAccount, type SessionRow } from "../src/auth/current-account";
import { tokenLookup } from "../src/auth/tokens";

const env = { S3_PUBLIC_ENDPOINT: "https://media.example.test/", BACK_URL: "https://api.example.test" };

async function row(token: string, overrides: Partial<SessionRow> = {}): Promise<SessionRow> {
  return {
    token_lookup: await tokenLookup(token),
    session_id: 10,
    session_aid: "sess",
    account_id: 1,
    account_aid: "acc",
    name: "なまえ",
    name_id: "nameid",
    status: 0,
    visibility: 0,
    adult: 1,
    admin: 0,
    icon_aid: "icon1",
    icon_status: 0,
    icon_variant_type: "webp",
    icon_rating: 0,
    ...overrides,
  };
}

const finder = (rows: SessionRow[]): FindSessions & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = async (lookups: string[]) => {
    calls.push(lookups);
    return rows.filter((r) => lookups.includes(r.token_lookup));
  };
  return Object.assign(fn, { calls });
};

describe("resolveCurrentAccount", () => {
  it("トークンがなければ DB に問い合わせない", async () => {
    const find = finder([]);
    expect(await resolveCurrentAccount([], find, env)).toBeNull();
    expect(find.calls).toEqual([]);
  });

  it("先頭から見て最初に有効なトークンのアカウントになる", async () => {
    const find = finder([await row("second", { account_id: 2, account_aid: "two" }), await row("third", { account_id: 3 })]);
    const result = await resolveCurrentAccount(["first", "second", "third"], find, env);
    expect(result?.account.id).toBe(2);
    expect(result?.account.aid).toBe("two");
    expect(find.calls).toHaveLength(1);
  });

  it("有効なトークンがなければ null", async () => {
    expect(await resolveCurrentAccount(["nope"], finder([]), env)).toBeNull();
  });

  it("アカウントの値を変換する", async () => {
    const result = await resolveCurrentAccount(["tok"], finder([await row("tok", { adult: 0, admin: 1 })]), env);
    expect(result).toEqual({
      session: { id: 10, aid: "sess" },
      account: {
        id: 1, aid: "acc", name: "なまえ", nameId: "nameid",
        iconUrl: "https://media.example.test/images/variants/icon1.webp",
        status: 0, visibility: 0, adult: false, admin: true,
      },
    });
  });

  it("アイコンがなければロゴ、見せられないアイコンなら代わりの画像", async () => {
    const none = await resolveCurrentAccount(["a"], finder([await row("a", { icon_aid: null })]), env);
    expect(none?.account.iconUrl).toBe("https://api.example.test/static_assets/images/amiverse-logo.webp");

    for (const overrides of [{ icon_status: 2 }, { icon_variant_type: null }, { icon_rating: 3 }]) {
      const hidden = await resolveCurrentAccount(["b"], finder([await row("b", overrides)]), env);
      expect(hidden?.account.iconUrl).toBe("https://api.example.test/static_assets/images/amiverse-1.webp");
    }
  });
});

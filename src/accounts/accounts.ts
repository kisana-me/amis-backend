// 本体の accounts を Hyperdrive で読む。D1 には写しを持たず、必要なときに都度引く
import type { Bindings } from "../env";
import type { MainDb } from "../lib/main-db";

export type Account = {
  id: number;
  aid: string;
  name: string;
  nameId: string;
  iconUrl: string;
  // 本体の accounts.status / visibility と同じ数値
  status: number;
  visibility: number;
  // 18 歳以上。見せてよいレーティングの上限に使う (本体の Account#adult?)
  adult: boolean;
  admin: boolean;
};

export const ACCOUNT_STATUSES = { normal: 0, locked: 1, deleted: 2 } as const;

export type AccountRow = {
  account_id: number;
  account_aid: string;
  name: string;
  name_id: string;
  status: number;
  visibility: number;
  adult: number;
  admin: number;
  icon_aid: string | null;
  icon_status: number | null;
  icon_variant_type: string | null;
  icon_rating: number | null;
};

type UrlEnv = Pick<Bindings, "S3_PUBLIC_ENDPOINT" | "BACK_URL">;

// アカウントとアイコンの列。プレースホルダの 1 つ目は必ず「今」(adult の判定に使う)。
// DATETIME の比較は NOW() ではなくこちらから渡す (DB サーバーのタイムゾーンに左右されないように)
export const ACCOUNT_COLUMNS = `
  a.id AS account_id, a.aid AS account_aid, a.name, a.name_id, a.status, a.visibility,
  (a.birthdate IS NOT NULL AND a.birthdate <= ? - INTERVAL 18 YEAR) AS adult,
  COALESCE(JSON_CONTAINS(a.meta, '"admin"', '$.roles'), 0) AS admin,
  i.aid AS icon_aid, i.status AS icon_status, i.variant_type AS icon_variant_type, i.rating AS icon_rating`;

export const ACCOUNT_ICON_JOIN = "LEFT JOIN images i ON i.id = a.icon_id";

const RATING_REJECTED = 3;

export function toAccount(row: AccountRow, env: UrlEnv): Account {
  return {
    id: Number(row.account_id),
    aid: row.account_aid,
    name: row.name,
    nameId: row.name_id,
    iconUrl: iconUrl(row, env),
    status: row.status,
    visibility: row.visibility,
    adult: Boolean(Number(row.adult)),
    admin: Boolean(Number(row.admin)),
  };
}

// 一覧の作者表示用。1 ページ分の id をまとめて引く。
// 本体と同じく、作者の状態では絞り込まない (削除されたアカウントのものは purge で消える)
export async function findAccountsByIds(db: MainDb, env: UrlEnv, ids: number[]): Promise<Map<number, Account>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a ${ACCOUNT_ICON_JOIN} WHERE a.id IN (?)`,
    [new Date(), unique],
  );
  return new Map(rows.map((row) => [Number(row.account_id), toAccount(row, env)]));
}

export async function findAccountByNameId(db: MainDb, env: UrlEnv, nameId: string): Promise<Account | null> {
  const rows = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a ${ACCOUNT_ICON_JOIN} WHERE a.name_id = ? LIMIT 1`,
    [new Date(), nameId],
  );
  return rows[0] ? toAccount(rows[0], env) : null;
}

// 本体の v1/amis/shared/_author.json.jbuilder と同じ形
export function authorJson(account: Account | undefined | null) {
  if (!account) return null;
  return { name: account.name, name_id: account.nameId, icon_url: account.iconUrl };
}

// 本体の Account#icon_url と Image#image_url と同じ判定。
// アイコンがなければロゴ、あっても見せられない状態なら Image#image_url の代わりの画像になる
function iconUrl(row: AccountRow, env: UrlEnv): string {
  if (row.icon_aid === null) return new URL("/static_assets/images/amiverse-logo.webp", env.BACK_URL).toString();

  const usable = row.icon_status === 0 && !!row.icon_variant_type?.trim() && row.icon_rating !== RATING_REJECTED;
  if (usable) return joinUrl(env.S3_PUBLIC_ENDPOINT, `images/variants/${row.icon_aid}.webp`);
  return new URL("/static_assets/images/amiverse-1.webp", env.BACK_URL).toString();
}

// Ruby の File.join と同じく、間の "/" を 1 つにそろえる
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

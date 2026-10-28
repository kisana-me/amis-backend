// 本体の current_account に当たるもの。トークンから今のセッションとアカウントを決める
import type { Bindings } from "../env";
import type { MainDb } from "../lib/main-db";
import { tokenLookup } from "./tokens";

export type CurrentSession = { id: number; aid: string };

export type CurrentAccount = {
  id: number;
  aid: string;
  name: string;
  nameId: string;
  iconUrl: string;
  // 本体の accounts.status / visibility と同じ数値 (deleted のアカウントはここに来ない)
  status: number;
  visibility: number;
  // 18 歳以上。見せてよいレーティングの上限に使う (本体の Account#adult?)
  adult: boolean;
  admin: boolean;
};

export type SessionRow = {
  token_lookup: string;
  session_id: number;
  session_aid: string;
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

export type FindSessions = (lookups: string[]) => Promise<SessionRow[]>;

const DELETED = 2;
const RATING_REJECTED = 3;

// アカウントとアイコンも JOIN で一緒に取る。sessions / accounts の status は 2 が deleted。
// DATETIME の比較に使う「今」は NOW() ではなくこちらから渡す (DB サーバーのタイムゾーンに左右されないように)
const FIND_SESSIONS_SQL = `
  SELECT s.token_lookup, s.id AS session_id, s.aid AS session_aid,
         a.id AS account_id, a.aid AS account_aid, a.name, a.name_id, a.status, a.visibility,
         (a.birthdate IS NOT NULL AND a.birthdate <= ? - INTERVAL 18 YEAR) AS adult,
         COALESCE(JSON_CONTAINS(a.meta, '"admin"', '$.roles'), 0) AS admin,
         i.aid AS icon_aid, i.status AS icon_status, i.variant_type AS icon_variant_type, i.rating AS icon_rating
  FROM sessions s
  JOIN accounts a ON a.id = s.account_id
  LEFT JOIN images i ON i.id = a.icon_id
  WHERE s.token_lookup IN (?)
    AND s.status <> ${DELETED}
    AND s.token_expires_at > ?
    AND a.status <> ${DELETED}`;

export function findSessionsIn(db: MainDb): FindSessions {
  return (lookups) => {
    const now = new Date();
    return db.query<SessionRow>(FIND_SESSIONS_SQL, [now, lookups, now]);
  };
}

// 先頭のトークンから順に見て、最初に有効なものが今のセッション (本体と同じ)。
// 本体はトークンごとに SQL を投げるが、ここでは 1 本にまとめて順番だけ合わせる
export async function resolveCurrentAccount(
  tokens: string[],
  findSessions: FindSessions,
  env: Pick<Bindings, "S3_PUBLIC_ENDPOINT" | "BACK_URL">,
): Promise<{ account: CurrentAccount; session: CurrentSession } | null> {
  if (tokens.length === 0) return null;

  const lookups = await Promise.all(tokens.map(tokenLookup));
  const rows = await findSessions([...new Set(lookups)]);
  const byLookup = new Map(rows.map((row) => [row.token_lookup.toLowerCase(), row]));
  const row = lookups.map((lookup) => byLookup.get(lookup)).find((r) => r !== undefined);
  if (!row) return null;

  return {
    session: { id: Number(row.session_id), aid: row.session_aid },
    account: {
      id: Number(row.account_id),
      aid: row.account_aid,
      name: row.name,
      nameId: row.name_id,
      iconUrl: iconUrl(row, env),
      status: row.status,
      visibility: row.visibility,
      adult: Boolean(Number(row.adult)),
      admin: Boolean(Number(row.admin)),
    },
  };
}

// 本体の Account#icon_url と Image#image_url と同じ判定。
// アイコンがなければロゴ、あっても見せられない状態なら Image#image_url の代わりの画像になる
function iconUrl(row: SessionRow, env: Pick<Bindings, "S3_PUBLIC_ENDPOINT" | "BACK_URL">): string {
  if (row.icon_aid === null) return new URL("/static_assets/images/amiverse-logo.webp", env.BACK_URL).toString();

  const usable = row.icon_status === 0 && !!row.icon_variant_type?.trim() && row.icon_rating !== RATING_REJECTED;
  if (usable) return joinUrl(env.S3_PUBLIC_ENDPOINT, `images/variants/${row.icon_aid}.webp`);
  return new URL("/static_assets/images/amiverse-1.webp", env.BACK_URL).toString();
}

// Ruby の File.join と同じく、間の "/" を 1 つにそろえる
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

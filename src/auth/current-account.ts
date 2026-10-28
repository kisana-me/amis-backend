// 本体の current_account に当たるもの。トークンから今のセッションとアカウントを決める
import { ACCOUNT_COLUMNS, ACCOUNT_ICON_JOIN, ACCOUNT_STATUSES, type Account, type AccountRow, toAccount } from "../accounts/accounts";
import type { Bindings } from "../env";
import type { MainDb } from "../lib/main-db";
import { tokenLookup } from "./tokens";

export type CurrentAccount = Account;
export type CurrentSession = { id: number; aid: string };

export type SessionRow = AccountRow & {
  token_lookup: string;
  session_id: number;
  session_aid: string;
};

export type FindSessions = (lookups: string[]) => Promise<SessionRow[]>;

const SESSION_DELETED = 2;

// sessions と accounts (とアイコン) を 1 本で引く。セッションもアカウントも deleted は通さない
const FIND_SESSIONS_SQL = `
  SELECT s.token_lookup, s.id AS session_id, s.aid AS session_aid, ${ACCOUNT_COLUMNS}
  FROM sessions s
  JOIN accounts a ON a.id = s.account_id
  ${ACCOUNT_ICON_JOIN}
  WHERE s.token_lookup IN (?)
    AND s.status <> ${SESSION_DELETED}
    AND s.token_expires_at > ?
    AND a.status <> ${ACCOUNT_STATUSES.deleted}`;

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
    account: toAccount(row, env),
  };
}

import type { CurrentAccount, CurrentSession } from "./auth/current-account";
import type { Db } from "./db/client";
import type { MainDb } from "./lib/main-db";

export type Bindings = {
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
  S3_PUBLIC_ENDPOINT: string;
  BACK_URL: string;
  MAIN_DB_TIMEZONE: string;
  // CORS と CSRF (Origin の確認) で許可するフロントのオリジン。カンマ区切り
  ALLOWED_ORIGINS: string;
  // 週の原価上限 (マイクロ USD)。全アカウント共通で、0 以下は無制限
  WEEKLY_COST_LIMIT_MICRO: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    db: Db;
    mainDb: MainDb;
    currentAccount: CurrentAccount | null;
    currentSession: CurrentSession | null;
  };
};

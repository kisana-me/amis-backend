import type { CurrentAccount, CurrentSession } from "./auth/current-account";
import type { MainDb } from "./lib/main-db";

export type Bindings = {
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
  S3_PUBLIC_ENDPOINT: string;
  BACK_URL: string;
  MAIN_DB_TIMEZONE: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    mainDb: MainDb;
    currentAccount: CurrentAccount | null;
    currentSession: CurrentSession | null;
  };
};

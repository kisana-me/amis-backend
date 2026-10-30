import type { CurrentAccount, CurrentSession } from "./auth/current-account";
import type { Db } from "./db/client";
import type { AiEnv } from "./generation/ai-client";
import type { MainDb } from "./lib/main-db";
import type { ImageProcessor } from "./media/images";

// API キーと AI Gateway の設定 (AiEnv) は secret で渡す
export type Bindings = AiEnv & {
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
  SEND_LIMITER: RateLimit;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  // 本体の公開バケットの URL (アカウントのアイコン)
  S3_PUBLIC_ENDPOINT: string;
  // Amis のバケット (amis-media) の公開 URL (キャラ・プロット・ペルソナの画像)
  AMIS_MEDIA_URL: string;
  // wrangler dev だけで "true" にする。ローカルの R2 の画像を Worker から配る (routes/media.ts)
  SERVE_LOCAL_MEDIA?: string;
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
    imageProcessor: ImageProcessor;
    currentAccount: CurrentAccount | null;
    currentSession: CurrentSession | null;
  };
};

# 全体構成と技術スタック

## 全体像

```
              ┌─ Gateway Worker ─┬─ /v1/amis/*  ──▶ Amis Worker (Service Binding)
フロント ──▶   │                  └─ それ以外    ──▶ Rails (本体)
(OpenNext)

Amis Worker ──▶ D1 (amis)        R2 (amis/ 配下)     Images      AI Gateway
            ──▶ 生成は SSE のリクエストの中 (DO・Queue は使わない)   Cron Triggers
            ──▶ Hyperdrive ──▶ 本体 MariaDB (accounts / sessions を読むだけ)
            ──▶ 本体 internal API (コイン・通知)
本体 ──▶ Amis の Queue (アカウントの状態変更・purge のイベント)
```

- 本体のデータは「読むときは Hyperdrive、変えるときは本体の API」。Amis が本体の DB に書き込むことはしない
- Gateway Worker は本体側 (`amiverse-backend` の `edge/`) に置く。本体を Workers に移すときの土台にもなる
- セッションの検証は Auth Worker に分けず、Amis の中で Hyperdrive を引いて行う (boundary.md の「認証」)
- フロントの API の向き先 (`NEXT_PUBLIC_BACK_URL`) は Gateway に向ける。`/v1/amis/*` のパスは今のまま変えない

## 技術スタック

| 役割 | 採用 | 補足 |
|---|---|---|
| 言語 / 実行環境 | TypeScript / Workers (`nodejs_compat`) | フロントに合わせて TypeScript 6、wrangler 4 |
| HTTP | Hono | 認証や Origin チェックのミドルウェア、エラー処理、管理画面の JSX |
| 入力検証 | zod (`@hono/zod-validator`) | Rails の `json_schemer` で検証していた部分の置き換え |
| DB (Amis) | D1 + Drizzle (`drizzle-orm/d1`, sqlite-core) | スキーマは TS で書き、マイグレーションは drizzle-kit で生成する。適用は `wrangler d1 migrations` |
| DB (本体を読む) | Hyperdrive + mysql2、SQL は直接書く | accounts / sessions を読むだけなので ORM は使わない。DB ユーザーは SELECT 権限だけ |
| 生成と配信 | SSE (リクエストの中で生成) | WebSocket・DO・Queue は使わない (下の「ストリーミング」と decisions.md を参照) |
| 非同期処理 | Queues | 画像とテキストの自動判定、本体からのイベント受信 |
| 定期実行 | Cron Triggers | `SweepGuestsJob` / `SweepStalledMessagesJob` の置き換え |
| 段数の多い処理 | Workflows (必要なら) | `ChapterSummaryJob` など |
| AI | AI Gateway | Rails の `AiClient` の provider 定義をそのまま TS の fetch に移す |
| 画像 | Images バインディング + R2 | Amis 専用のバケット `amis-media` の `images/variants/` |
| OG 画像 | workers-og (satori + resvg-wasm) | 日本語フォントはサブセット化して R2 に置く |
| レート制限 | Rate Limiting バインディング | 1 分あたり 10 通。Redis の INCR の置き換え |
| キャッシュ | KV または Cache API | 週の原価の集計 |
| 管理画面 | Hono JSX (SSR) + Cloudflare Access | 管理者のログインは Access に任せる |
| テスト | Vitest + `@cloudflare/vitest-plugin` | D1 をローカルで動かして試す。本体の DB は差し替え、`scripts/compare.ts` で本体と突き合わせる |
| 監視 | Workers Logs / Traces | フロントの `wrangler.jsonc` と同じ設定にする |
| 環境 | wrangler の env (staging / production) | D1、R2 のパス、Hyperdrive は環境ごとに分ける |

## D1 の扱い

- **トランザクションは `batch()` だけ。** 途中で読んで判断してから書く、という形のトランザクションは開けない。クォータの消費のような「読んでから書く」処理は、次のどちらかで書く
  - 条件付きの UPDATE (`UPDATE ... SET used_count = used_count + 1 WHERE ... AND used_count < ?` を実行し、変わった行数を見る)
- **書き込みは 1 つの DB に直列で入る。** 生成中の本文は 1 チャンクごとに書かず、1 秒ごとにまとめて書く
- **容量は 1 DB あたり 10GB まで。** いちばん大きくなるのは `amis_chat_messages`。今の量と増え方を確認したうえで、古いチャットを R2 に退避するか DB を分けるかを決める (未決。migration.md の「未決事項」を参照)
- `rating` は本体と同じく生成カラム (`COALESCE(mod_rating, MAX(user_rating, COALESCE(auto_rating, 0)))`) にする。SQLite では `GREATEST` ではなく複数引数の `MAX` を使う

## ストリーミング (生成と配信)

今の `Amis::ChatChannel` は、サーバーからクライアントへの一方向だけの通信になっている。クライアントはメッセージ単位で購読し、サーバーは snapshot → 行ごとの差分 (`seq` 付き) → done を送る。キャンセルは別の POST。この形をそのまま SSE に移す。

```
POST /v1/amis/chats/:aid/messages    メッセージを pending で作って、すぐ返す
POST /v1/amis/messages/:aid/stream   SSE: snapshot → delta(seq) … → done
POST /v1/amis/messages/:aid/cancel   状態を canceled にする
```

stream も POST にしている。ほかの API と同じく、Cookie で来たときは Origin を確かめる (CSRF) ため。

### 生成は SSE のリクエストの中で動かす (`src/generation/run.ts`)

DO や Queue は使わない (decisions.md の 11)。

1. `pending` のメッセージを `streaming` に切り替えられた接続 (条件付きの UPDATE で、最初につないだ 1 本だけ) が、その場で上流を呼んで差分を流す (今の `ChatCompletionJob` と `Broadcaster`)
2. 途中経過は 1 秒ごとに D1 に書く。差分が来ない間 (推論中など) も `streamed_at` だけは進める
3. 書き込みのときに状態が `streaming` でなくなっていたら (キャンセルされたら)、上流への接続を切って止める
4. ほかの接続 (別のタブやリロード) は、D1 の途中経過を 0.5 秒ごとに読んで差分にして流す
5. 生成していないメッセージにつないだときは、D1 の内容を snapshot と done として返してすぐ閉じる

クライアントが切断しても生成は `ctx.waitUntil()` で続くが、**切断から最大 30 秒まで**しか延ばせない。それを超えて止まったものは `streamed_at` が進まなくなるので、30 秒動いていない `streaming` と、60 秒誰もつながなかった `pending` を失敗に倒す (`src/generation/stall.ts`、今の `SweepStalledMessagesJob`)。判定は、チャットを開いたときと送信のとき、途中経過を読んでいるときに行う。

SSE の書き込みは完了を待たない。待つと、受け取りの遅い接続に生成が縛られる (ストリームの背圧)。

### クライアント

- `EventSource` は POST も `Authorization` ヘッダも送れない。ネイティブアプリは Bearer トークンで認証しているので、`fetch` で返ってきた ReadableStream を読む形にする
- フロントの `src/features/amis/hooks/useChatStream.ts` を SSE を読む形に書き換え、Amis では `src/lib/cable.ts` (ActionCable) を使わないようにする

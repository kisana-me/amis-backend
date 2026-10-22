# 全体構成と技術スタック

## 全体像

```
              ┌─ Gateway Worker ─┬─ /v1/amis/*  ──▶ Amis Worker (Service Binding)
フロント ──▶   │                  └─ それ以外    ──▶ Rails (本体)
(OpenNext)    └─ Auth Worker (セッション検証。Gateway と Amis の両方から呼ぶ)

Amis Worker ──▶ D1 (amis)        R2 (amis/ 配下)     Images      AI Gateway
            ──▶ Durable Objects (生成とストリーム配信)  Queues      Cron Triggers
            ──▶ Hyperdrive ──▶ 本体 MariaDB (accounts / sessions を読むだけ)
            ──▶ 本体 internal API (コイン・通知)
本体 ──▶ Amis の Queue (アカウントの状態変更・purge のイベント)
```

- 本体のデータは「読むときは Hyperdrive、変えるときは本体の API」。Amis が本体の DB に書き込むことはしない
- Gateway Worker と Auth Worker は本体側 (`amiverse-backend` の `edge/`) に置く。本体を Workers に移すときの土台にもなる
- フロントの API の向き先 (`NEXT_PUBLIC_BACK_URL`) は Gateway に向ける。`/v1/amis/*` のパスは今のまま変えない

## 技術スタック

| 役割 | 採用 | 補足 |
|---|---|---|
| 言語 / 実行環境 | TypeScript / Workers (`nodejs_compat`) | フロントに合わせて TypeScript 6、wrangler 4 |
| HTTP | Hono | 認証や Origin チェックのミドルウェア、エラー処理、管理画面の JSX |
| 入力検証 | zod (`@hono/zod-validator`) | Rails の `json_schemer` で検証していた部分の置き換え |
| DB (Amis) | D1 + Drizzle (`drizzle-orm/d1`, sqlite-core) | スキーマは TS で書き、マイグレーションは drizzle-kit で生成する。適用は `wrangler d1 migrations` |
| DB (本体を読む) | Hyperdrive + mysql2、SQL は直接書く | accounts / sessions を読むだけなので ORM は使わない。DB ユーザーは SELECT 権限だけ |
| 生成と配信 | Durable Objects + SSE | WebSocket は使わない (下の「ストリーミング」と decisions.md を参照) |
| 非同期処理 | Queues | 画像とテキストの自動判定、本体からのイベント受信 |
| 定期実行 | Cron Triggers | `SweepGuestsJob` / `SweepStalledMessagesJob` の置き換え |
| 段数の多い処理 | Workflows (必要なら) | `ChapterSummaryJob` など |
| AI | AI Gateway | Rails の `AiClient` の provider 定義をそのまま TS の fetch に移す |
| 画像 | Images バインディング + R2 | `amis/images/originals/`、`amis/images/variants/` |
| OG 画像 | workers-og (satori + resvg-wasm) | 日本語フォントはサブセット化して R2 に置く |
| レート制限 | Rate Limiting バインディング | 1 分あたり 10 通。Redis の INCR の置き換え |
| キャッシュ | KV または Cache API | bcrypt の照合結果、週の原価の集計 |
| 管理画面 | Hono JSX (SSR) + Cloudflare Access | 管理者のログインは Access に任せる |
| テスト | Vitest + `@cloudflare/vitest-pool-workers` | D1・DO・Queues をローカルで動かして試す |
| 監視 | Workers Logs / Traces | フロントの `wrangler.jsonc` と同じ設定にする |
| 環境 | wrangler の env (staging / production) | D1、R2 のパス、Hyperdrive は環境ごとに分ける |

## D1 の扱い

- **トランザクションは `batch()` だけ。** 途中で読んで判断してから書く、という形のトランザクションは開けない。クォータの消費のような「読んでから書く」処理は、次のどちらかで書く
  - 条件付きの UPDATE (`UPDATE ... SET used_count = used_count + 1 WHERE ... AND used_count < ?` を実行し、変わった行数を見る)
  - 同じ対象への処理を DO の中で順番に並べる
- **書き込みは 1 つの DB に直列で入る。** 生成中の本文は 1 チャンクごとに書かず、DO でまとめてから書く
- **容量は 1 DB あたり 10GB まで。** いちばん大きくなるのは `amis_chat_messages`。今の量と増え方を確認したうえで、古いチャットを R2 に退避するか DB を分けるかを決める (未決。migration.md の「未決事項」を参照)
- `rating` は本体と同じく生成カラム (`COALESCE(mod_rating, MAX(user_rating, COALESCE(auto_rating, 0)))`) にする。SQLite では `GREATEST` ではなく複数引数の `MAX` を使う

## ストリーミング (生成と配信)

今の `Amis::ChatChannel` は、サーバーからクライアントへの一方向だけの通信になっている。クライアントはメッセージ単位で購読し、サーバーは snapshot → 行ごとの差分 (`seq` 付き) → done を送る。キャンセルは別の POST。この形をそのまま SSE に移す。

```
POST /v1/amis/chats/:aid/messages    メッセージを作り、DO に生成を頼む
GET  /v1/amis/messages/:aid/stream   SSE: snapshot → delta(seq) … → done
POST /v1/amis/messages/:aid/cancel   DO に中断を伝える
```

### Durable Object の役割

DO はメッセージごとに 1 つ (`idFromName(message_aid)`) 置く。

1. AI Gateway からストリーミングで受け取り、パースする (今の `SceneStreamParser` / `ScenePresenter` に当たる処理)。同じ行への差分はまとめてから送る (`Amis::Broadcaster#coalesce` と同じ)
2. 接続中の SSE すべてに差分を配る。複数のタブや端末で同じメッセージを見ていても、全員に届く
3. snapshot と seq を DO のメモリとストレージに持つ。今は Redis のバッファでやっている役割で、再接続したときは snapshot → 続きの差分の順に送るので隙間ができない。クライアントは `seq <= snapshot.seq` の差分を捨てる (今と同じ約束)
4. D1 への途中経過の書き込みは一定間隔でまとめて行い、完了時に確定させる
5. 生成が止まったかどうかは DO の alarm で見張る (`SweepStalledMessagesJob` の役割)
6. 失敗したときやキャンセルされたときは、クォータとコインを返す。返すのは 1 回だけ (下の boundary.md の「コイン」を参照)

生成していないメッセージに SSE をつないだときは、D1 の内容を snapshot と done として返してすぐ閉じる。

生成はクライアントの接続とは独立して DO の中で進むので、リロードやタブの切り替えで生成が止まることはない。接続しているのは生成中の数秒〜数分だけなので、WebSocket Hibernation は必要ない。

### クライアント

- `EventSource` は POST も `Authorization` ヘッダも送れない。ネイティブアプリは Bearer トークンで認証しているので、`fetch` で返ってきた ReadableStream を読む形にする
- フロントの `src/features/amis/hooks/useChatStream.ts` を SSE を読む形に書き換え、Amis では `src/lib/cable.ts` (ActionCable) を使わないようにする

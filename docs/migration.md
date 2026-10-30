# 移行手順

最初から D1 で作り、ステージングで検証してから一括で切り替える。本体側の作業は Amis の開発と並行して先に進められる。

## 手順

### 0. 本体から DM AI 機能を消す (本体だけで完結する)

境界が単純になるので最初にやる。消えるもの:

- `ai_agents` と、DM の AI 応答 (`Chat::AiResponder`, `Chat::CompletionJob`)
- 本体側の `AiQuotaService` / `AiClient` の利用箇所
- 管理画面の `ai_agents` / `ai_models` (Amis の管理画面に移す)

この時点ではテーブル (`ai_models` / `ai_usages` / `ai_daily_quotas`) はまだ消さない。Amis の Rails 側の実装がまだ使っているので、手順 5 で D1 に移してから消す。

### 1. Gateway を作る (`amiverse-backend/edge/`)

- Gateway: 最初は全部 Rails に転送するだけ。`NEXT_PUBLIC_BACK_URL` を Gateway に向ける

### 2. Amis Worker を作る (このリポジトリ)

- D1 のスキーマ: 本体の `schema.rb` の `amis_*` と `ai_models` / `ai_usages` を SQLite 向けに書き直し、`images` / `reports` / `moderation_results` を足す (テーブル名から `amis_` は外す。アカウントの写しは持たない)
- `/v1/amis/*` の全エンドポイントを、今のレスポンスの形のまま (フロントの変更を最小にするため) 実装する
- DO による生成と SSE、Queues、Cron、画像、OG、通報、管理画面

### 3. 本体に internal API とイベント送信を足す

- `/internal/notifications` と、`notifications` の外部通知用カラム
- アカウントの purge のときに、Amis へイベントを送る

### 4. フロントを対応させる

- `useChatStream.ts` を SSE を読む形にする (`fetch` で ReadableStream を読む)
- Amis の通報の送り先を `/v1/amis/reports` にする
- OG 画像の URL を Amis に向ける

### 5. データを移して切り替える

1. ステージングで、本番 MariaDB のコピーから D1 へ流し込むスクリプトを何度か試し、件数と中身が合うか確かめる
2. 本番の切り替え
   1. Amis を書き込み停止にする (メンテナンス表示)
   2. `amis_*` と AI 系のテーブルを D1 に流し込む (`scripts/import-from-main.ts`)。画像は Amis が参照しているものだけを `images` に移し、表示用の WebP を `scripts/copy-images.ts` で本体のバケットから Amis のバケット (`amis-media`) へ同じキーでコピーする。元の画像と、削除済み (本体が `private/` に移したもの) の画像はコピーしない。通報 (本体の `reports` のうち Amis のもの) と画像の判定結果は持ってこない

      ```sh
      node scripts/import-from-main.ts import.sql            # import.sql と import.images.txt ができる
      wrangler d1 execute amis --remote --file import.sql
      S3_API_ENDPOINT=https://<アカウント ID>.r2.cloudflarestorage.com S3_REGION=auto S3_BUCKET=amiverse AMIS_BUCKET=amis-media \
        S3_USERNAME=... S3_PASSWORD=... node scripts/copy-images.ts import.images.txt
      ```

      R2 の API トークンには、`amiverse` の読み取りと `amis-media` の書き込みを付ける。公開の配信 (`AMIS_MEDIA_URL`) で `images/variants/` が読めることも確かめる
   3. Gateway で `/v1/amis/*` と `/og/amis/*` の振り分け先を Amis Worker に切り替える
3. しばらく様子を見て問題がなければ、本体から Amis 関連のコードとテーブルを消す (下の一覧)

切り戻しが必要になったら、Gateway の振り分けを Rails に戻す。D1 に移ったあとの書き込みは Rails に戻らないので、切り替えの判断は書き込み停止中に済ませる。

## 本体で消す・書き換えるところ (手順 5 の最後)

| ファイル (`amiverse-backend`) | 内容 |
|---|---|
| `app/controllers/v1/amis/*`, `app/controllers/amis/*` (管理画面), `app/models/amis/*`, `app/models/amis.rb`, `app/services/amis/*`, `app/jobs/amis/*`, `app/channels/amis/*`, `app/views/amis`, `app/views/v1/amis` | 削除 |
| `app/models/ai_model.rb`, `ai_usage.rb`, `ai_daily_quota.rb`, `ai_agent.rb`, `app/services/ai_client*`, `ai_quota_service.rb`, `app/controllers/ai_models_controller.rb`, `ai_agents_controller.rb` | 削除 (AI 系はすべて Amis に移る) |
| `app/controllers/v1/application_controller.rb` | `promote_amis_guest` を削除 |
| `app/channels/application_cable/connection.rb` | ゲストの身元の確認を削除 |
| `app/models/concerns/rateable.rb` | `Amis::Guest` の分岐を削除 |
| `app/models/report.rb` | 通報対象の `amis_character` / `amis_plot` を削除 |
| `app/services/notification_creator.rb`, `app/controllers/v1/notifications_controller.rb` | Amis のレコードを参照している分岐を、外部通知の形に置き換える |
| `app/services/purge_service.rb`, `app/helpers/purges_helper.rb` | Amis の分を削除 (Amis 側に移す) |
| `app/services/rating_propagation.rb`, `app/jobs/rating_propagation_job.rb` | Amis のクラスを外す |
| `app/models/image.rb` | `amis_plot_images` / `amis_character_images` の関連を削除 |
| `app/controllers/og_images_controller.rb` | `amis_plot` / `amis_character` を削除 |
| `config/routes.rb` | `/v1/amis/*`、`/og/amis/*`、管理画面の Amis と AI のルートを削除 |
| `db/` | `amis_*` と AI 系のテーブルを消すマイグレーション。`accounts.meta` の `amis_*` キーも消す |

## 未決事項

- **D1 の容量:** `amis_chat_messages` の今の量と増え方を確かめる。本番で次を実行した結果をもとに見積もる

  ```sql
  SELECT table_name, table_rows, data_length + index_length AS bytes
  FROM information_schema.tables
  WHERE table_schema = 'amiverse_production' AND (table_name LIKE 'amis_%' OR table_name LIKE 'ai_%')
  ORDER BY bytes DESC;
  ```

  10GB に届きそうなら、古いチャットを R2 に退避するか、チャットのメッセージだけ別の D1 に分ける
- **ORM:** Drizzle で進めるつもり。D1 の `prepare().bind()` を直接書く方法も選べる (decisions.md を参照)

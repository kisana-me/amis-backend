# 本体との境界

基本の考え方は 1 つだけ。**本体のデータは、読むときは Hyperdrive、変えるときは本体の API を通す。** Amis が本体の DB に書き込むことはしない。

| 対象 | 持ち主 | Amis からの扱い方 |
|---|---|---|
| アカウント (`accounts`) | 本体 | Hyperdrive で読む + D1 に写し (`amis_accounts`) を持つ |
| セッション (`sessions`) | 本体 | Hyperdrive で読み、Auth Worker で検証する |
| コイン (`accounts.coin_balance` / `coin_transactions`) | 本体 | internal API |
| 通知 (`notifications` / Web Push) | 本体 | internal API |
| 無料枠・ボーナス・週の原価上限・レート制限 | Amis | D1 / Rate Limiting |
| AI モデル・利用記録 | Amis | D1 |
| 画像 | Amis | D1 (`amis_images`) + R2 (`amis/`) + Images |
| 通報・モデレーション | Amis | D1 + 管理画面 |
| OG 画像 | Amis | workers-og |

## 1. アカウント

### 読み方

- **認証と詳細表示:** 毎回 Hyperdrive で `accounts` を読む。主キーで引くので軽い
- **一覧 (プロット一覧、キャラ一覧、ホームなど):** D1 から取ったあとで「作者が削除済みのものを除く」とすると、1 ページの件数がずれる (D1 と MySQL は JOIN できない)。そこで D1 に本体アカウントの写し `amis_accounts` を持ち、一覧は D1 だけで絞り込む

### `amis_accounts` (本体アカウントの写し)

| カラム | 用途 |
|---|---|
| `id`, `aid`, `name`, `name_id`, `icon_url` | 作者の表示 |
| `status`, `visibility` | 削除・凍結されたアカウントのコンテンツを一覧から除く |
| `adult` (`birthdate` から計算) | 見せてよいレーティングの判定 (今の `Rateable.max_rating_for`) |
| `synced_at` | 写しがどれだけ古いか |

写しは次の 2 通りで更新する。

1. **本体からのイベント:** アカウントの状態やプロフィールが変わったら、本体が Amis の Queue に送る
2. **リクエストのたびに上書き:** 認証のたびに Hyperdrive で読んだ値で写しを書き換える

### アカウント単位の Amis の設定 (`amis_account_settings`)

今 `accounts.meta` に入っている次のキーは Amis の値なので、Amis 側に移す。

- `amis_bonus_remaining`, `amis_bonus_granted_at` (登録直後に 1 回だけ渡す 300 回分の別枠)
- `amis_weekly_cost_limit_micro` (アカウントごとの週の原価上限。0 以下は無制限)

### 物理削除 (purge)

本体でアカウントを物理削除するときは、本体がイベントを送る。Amis はそれを受けて自分の側のデータを消すか、参照を外す。今 `purge_service.rb:145-183` で Amis の分としてやっている処理を Amis 側に移す。

## 2. 認証

### 今の仕組み (本体)

- 暗号化された cookie `amiverse` (`domain: :all`, `tld_length: 2` なので `.amiverse.net` 全体で有効) に、トークンの配列が入っている
- 検証の手順 (`app/models/concerns/token_tools.rb`)
  1. トークンの SHA256 の先頭 36 文字で `sessions.token_lookup` を引く
  2. 取れた行の `token_digest` と bcrypt で照合する
- ネイティブアプリは `Authorization: Bearer <token>` で送ってくる

### Auth Worker でやること

この処理は Auth Worker に切り出し、Amis からも Gateway からも Service Binding で呼ぶ。本体を Workers に移すときも同じものを使う。

1. **cookie の復号:** Rails の `cookies.encrypted` は AES-256-GCM。鍵は `secret_key_base` から PBKDF2-SHA256 (salt は `"authenticated encrypted cookie"`) で作られている。WebCrypto で同じことができる。繰り返し回数などの細かい値は、実際の cookie を使って合っているか確かめる。Bearer のときは復号はいらない
2. **Hyperdrive で引く:** sessions と accounts を JOIN し、セッションの状態・有効期限・アカウントの状態を 1 本のクエリで取る。これは **毎回** 行う
3. **bcrypt の照合結果をキャッシュする:** 本番の bcrypt はコスト 12 で、Workers で照合すると 1 回あたり数百ミリ秒の CPU を使う。`sha256(token)` → `session_id` の対応を KV か Cache API に 5 分ほど置き、bcrypt はキャッシュがないときだけ行う。ログアウトや削除は 2 で毎回確かめるので、キャッシュがあってもすぐ反映される
4. 戻り値は `{ account_id, session_id, account: { status, ... } }`。Amis はこれを使って `amis_accounts` を書き換える

### CSRF

Rails の CSRF トークンはセッションに結びついていて、Rails の外では検証できない。Amis では、状態を変えるリクエストの **Origin ヘッダが許可済みのオリジンかどうか** を確かめる (cookie は SameSite=Lax)。Bearer で来たリクエストには CSRF のチェックはいらない。

フロントの `api.ts` は 419 が返るとトークンを取り直して再送するが、Amis は 419 を返さないのでこの処理は動かない。

### 体験版ゲスト

- Amis が独自に署名した cookie `amis_guest` を発行する。本体の Rails セッション (`_amiverse`) の `amis_guest_id` は使わない
- ログイン済みのリクエストに `amis_guest` が付いていたら、その場でゲストのチャットをアカウントに引き継ぐ (今は本体の sign_in の直後にやっている `promote_amis_guest` を Amis に移す)
- 移行の時点で存在するゲストは切り捨てる

## 3. 画像

Amis の中だけで完結させる。本体の `images` テーブルは使わない。

```
amis_images: id, aid, account_id, status, visibility,
             user_rating, auto_rating, mod_rating, rating (生成カラム),
             original_key, original_ext, variants (JSON), width, height,
             created_at, updated_at
R2 (本体と同じバケット):
  amis/images/originals/{aid}.{ext}
  amis/images/variants/{aid}/{variant}.webp
```

- アップロード時に Images バインディング (`env.IMAGES.input(...).transform(...).output(...)`) で変換し、R2 に保存する。必要になったときに作る遅延生成も同じ仕組みでできる
- 画像を参照するのは `amis_plot_images`, `amis_character_images`, そして Plot / Character / Persona の `icon_id`。この参照先をすべて `amis_images` に向ける
- 画像の自動判定 (今の `ModerationJob`) と、画像のレーティングをキャラクターに反映する処理 (今の `RatingPropagation` / `RatesLinkedMedia`) も Amis に移す。判定 API (`MODERATION_ENDPOINT`) は Queue のコンシューマーから呼ぶ

## 4. コイン

本体の台帳なので、Amis からは internal API を通して使う。Hyperdrive で直接書き込まない理由は [decisions.md](decisions.md) を参照。

### Amis 側に移すもの

今の `AiQuotaService` のうち、コイン以外はすべて Amis の持ち物になる。

| 今 | Amis での置き場所 |
|---|---|
| 1 日の無料枠 `FREE_PER_DAY = 100` (`ai_daily_quotas`) | D1 `amis_daily_quotas` |
| 初回ボーナス `INITIAL_BONUS = 300` (`accounts.meta`) | D1 `amis_account_settings` |
| 週の原価上限 (`ai_usages` の SUM と Redis のキャッシュ) | D1 `amis_ai_usages` と集計値のキャッシュ |
| 1 分あたりのレート制限 `RATE_LIMIT_PER_MINUTE = 10` (Redis の INCR) | Rate Limiting バインディング |
| AI モデルの定義 (`ai_models`) | D1 `amis_ai_models` |

### 消費の順番

順番は今と同じ。

1. レート制限
2. 週の原価上限
3. 無料枠 (無料モデルのとき)
4. ボーナス (無料モデルのとき)
5. ここまでで払えなければ、コイン API で消費する

3 と 4 は D1、5 は本体なので、同じトランザクションにはできない。**先に D1 の枠を確保し、コイン API が失敗したら確保した分を戻す** 順にする。何で払ったかは今と同じくメッセージの `meta.charge` に記録する。

### 返金

生成に失敗したときやキャンセルされたときに返す。今の設計 (「二重に返すより、返し損ねるほうが害が小さい」) をそのまま守り、返すのは 1 回だけにする。

- 無料枠とボーナスは D1 で戻す
- コインは refund API で戻す。`idempotency_key` が同じなら何度呼んでも 1 回分しか返らない
- メッセージに `meta.refunded_at` を付け、同じメッセージを二度と返金しない

## 5. 通知

Amis から本体の通知を送る場面がある。レーティングが引き上げられたとき (`rating_raised`) と、通報者へのお知らせ (今の `report_announced`) の 2 つ。今は `notifiable` に Amis のレコードを直接入れているが、DB が分かれるとそれができない。

- 本体の `notifications` テーブルに、外部サービスからの通知用のカラム (`url`, `title`, `icon_url`, `source`) を足し、`notifiable` を null にできるようにする
- Web Push も本体の仕組みでそのまま送る

## 6. 通報とモデレーション

Amis のコンテンツへの通報は Amis 側で持つ。

- 通報を受けたあとの対応 (ロック、`mod_rating` での上書き、非公開化) はすべて Amis の DB に対する操作なので、通報も Amis にあるほうが自然
- `amis_reports` テーブルと管理画面を用意する。通報の対象は `amis_character` と `amis_plot` (今の `Report#assign_reportable` の Amis の分岐と同じく、`is_normal` かつ `isnt_closed` のもの)
- 通報者へのお知らせは、上の通知 API を使う
- テキストのレーティング (今の `TextRating`) とその結果 (`moderation_results`) も Amis に移す

## 7. OG 画像

Amis 側で作る。

- `GET /og/amis/plots/:aid` と `GET /og/amis/characters/:aid` を workers-og で生成し、R2 か Cache API にキャッシュする
- 本体の `og_images#amis_plot` と `og_images#amis_character` は消し、フロントのメタタグの URL を Amis に向け直す

---

## internal API の仕様

### Amis → 本体

署名には、既存の anyur_cf からの内部呼び出しと同じ方式を使う (`amiverse-backend` の `app/controllers/internal/base_controller.rb`)。本体も Workers に移ったら Service Binding に置き換える。

```
POST /internal/coins/spend
  { account_id, amount, idempotency_key, memo }
  → 200 { ok: true, balance } | 402 { ok: false, balance }

POST /internal/coins/refund
  { idempotency_key }
  → 200 { ok: true, balance }   (返金済みでも 200。2 回目からは何もしない)

POST /internal/coins/balance
  { account_id }
  → 200 { balance }

POST /internal/notifications
  { recipient_id, action, title, body, url, icon_url, source: "amis" }
  → 201
```

- `idempotency_key` は `amis:msg:{message_aid}` のような値にする。本体の `coin_transactions` にユニーク制約付きのカラムとして追加する
- spend の `kind` は `amis_spend`、refund は `amis_refund` (今の値をそのまま使う)

### 本体 → Amis (Queue のイベント)

本体から Queues の HTTP API でメッセージを送る。

```
{ type: "account.updated", account_id, aid, status, visibility, name, name_id, icon_url, adult, occurred_at }
{ type: "account.purged",  account_id, occurred_at }
```

Amis のコンシューマーは `occurred_at` が `amis_accounts.synced_at` より古いイベントを捨てる (届く順番が入れ替わっても大丈夫なように)。

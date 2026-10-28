# 本体との境界

基本の考え方は 1 つだけ。**本体のデータは、読むときは Hyperdrive、変えるときは本体の API を通す。** Amis が本体の DB に書き込むことはしない。

| 対象 | 持ち主 | Amis からの扱い方 |
|---|---|---|
| アカウント (`accounts`) | 本体 | Hyperdrive で都度読む (D1 に写しは持たない) |
| セッション (`sessions`) | 本体 | Hyperdrive で読み、Amis の中で検証する |
| 通知 (`notifications` / Web Push) | 本体 | internal API |
| 週の原価上限・レート制限 | Amis | D1 / Rate Limiting |
| AI モデル・利用記録 | Amis | D1 |
| 画像 | Amis | D1 (`amis_images`) + R2 (`amis/`) + Images |
| 通報・モデレーション | Amis | D1 + 管理画面 |
| OG 画像 | Amis | workers-og |

## 1. アカウント

**D1 には写しを持たない。** 必要なときに毎回 Hyperdrive で本体の `accounts` を読む (`src/accounts/accounts.ts`)。

- **認証:** セッションと一緒に JOIN で取る (下の「認証」)
- **一覧の作者表示 (プロット一覧、キャラ一覧、ホームなど):** 1 ページ分の `author_id` をまとめて `WHERE id IN (...)` で 1 本引く (`findAccountsByIds`)
- **アカウントのページ (`/amis/accounts/@:name_id`):** `name_id` で引く (`findAccountByNameId`)

一覧は、本体と同じく**作者のアカウントの状態では絞り込まない。** 本体の一覧の条件はコンテンツ自身の `status: normal` と `visibility: opened` だけで、削除されたアカウントのコンテンツは物理削除 (purge) のときに片付けている。そのため「D1 から取ったあとで作者の状態で除くと 1 ページの件数がずれる」という問題は起きず、写しは要らない。

D1 の `account_id` / `author_id` は本体の `accounts.id` をそのまま入れ、外部キーは張らない。

### 物理削除 (purge)

本体でアカウントを物理削除するときは、本体がイベントを送る。Amis はそれを受けて自分の側のデータを消すか、参照を外す。今 `purge_service.rb:145-183` で Amis の分としてやっている処理を Amis 側に移す。

## 2. 認証

サインイン Cookie の仕様は `amiverse-docs` の `session-cookie.md` にある。本体は bcrypt をやめ、Cookie `amiverse` の中身をトークンを `.` でつないだだけの形式 (新形式) に移している。これで Rails の外でも、復号なし・bcrypt なしで検証できる。

### Amis でやること (`src/auth/`, `src/middleware/auth.ts`)

本体の `before_action :current_account` と同じく、すべてのリクエストで今のアカウントを決める。

1. **トークンを取り出す:** Cookie `amiverse` が新形式ならそれを `.` で分ける。旧形式 (Rails の暗号化 Cookie) は読まず、未サインインとして扱う (サイトを開いた時点で本体が新形式に書き換えるため)。Cookie から取れなければ `Authorization: Bearer`
2. **Hyperdrive で引く:** 各トークンの `sha256_hex(token)[0, 36]` で、sessions・accounts・アイコンの images を JOIN した SQL を **毎回 1 本** 投げる。先頭のトークンから見て、最初に有効なものが今のセッション
3. **キャッシュはしない。** bcrypt がなくなったので、SQL 1 本で十分軽い。Hyperdrive のクエリキャッシュも無効にする (ログアウトをすぐ反映させるため)
4. 結果は `c.var.currentAccount` (`id`, `aid`, `name`, `nameId`, `iconUrl`, `status`, `visibility`, `adult`, `admin`) と `c.var.currentSession`

本体の DATETIME は `TZ=Asia/Tokyo` + `default_timezone :local` なので、タイムゾーンなしの JST で入っている。期限の比較に使う「今」は SQL の `NOW()` ではなく Worker から渡し、mysql2 の `timezone` を `MAIN_DB_TIMEZONE` (`+09:00`) にそろえる。

この処理は、本体を Workers に移すときにも同じものを使う。

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

## 4. 利用の制限

**Amis ではコインを使わない。** 本体の `AiQuotaService` のうち、1 日の無料枠・初回ボーナス・コインの消費はなくし、次の 2 つだけを残す。

| 今 | Amis での置き場所 |
|---|---|
| 週の原価上限 (`ai_usages` の SUM と Redis のキャッシュ) | D1 `ai_usages` と集計値のキャッシュ。上限は全アカウント共通の設定値にする (アカウントごとの上書きは、必要になったら足す) |
| 1 分あたりのレート制限 `RATE_LIMIT_PER_MINUTE = 10` (Redis の INCR) | Rate Limiting バインディング |
| AI モデルの定義 (`ai_models`) | D1 `ai_models` |

確かめる順番は、レート制限 → 週の原価上限。どちらも Amis の中で完結するので、本体の API は呼ばない。生成に失敗したときやキャンセルされたときも、返すものはない (原価は実際に使った分だけを `ai_usages` に記録する)。

フロントはコインの残高やモデルごとの `coin_cost` を表示しているので、`/amis/status` などは今と同じ形で返し、`coin_cost` は 0 にする。

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
POST /internal/notifications
  { recipient_id, action, title, body, url, icon_url, source: "amis" }
  → 201
```

### 本体 → Amis (Queue のイベント)

本体から Queues の HTTP API でメッセージを送る。

```
{ type: "account.purged", account_id, occurred_at }
```

アカウントの情報は都度読むので、プロフィールや状態が変わったことを知らせるイベントは要らない。物理削除だけは Amis 側のデータを消す必要があるので、イベントを受け取る。

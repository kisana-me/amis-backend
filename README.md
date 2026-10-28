# amis-backend

Amis (AI キャラクターチャットサービス) のバックエンド。Amiverse 本体 (Rails / `kisana-me/amiverse-backend`) から恒久的に切り出し、Cloudflare Workers + D1 で動かす。

現在は設計段階。実装はこのドキュメントに沿って進める。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 全体構成と技術スタック、ストリーミングの設計 |
| [docs/boundary.md](docs/boundary.md) | 本体との境界 (Account・認証・画像・利用の制限・通知・通報・OG) と internal API の仕様 |
| [docs/migration.md](docs/migration.md) | 移行手順と、本体 / フロント側で必要な作業の一覧 |
| [docs/decisions.md](docs/decisions.md) | 設計判断の記録 (なぜそうしたか) |

## 前提として決まっていること

- Amis は **恒久的に別サービス** にする。専用の Workers と D1 を持つ
- 本体の **DM AI 機能は廃止** する。AI 系のテーブルとコード (`ai_models` / `ai_usages` / `ai_daily_quotas` / `ai_agents` / `AiClient` / `AiQuotaService`) はすべて Amis の持ち物になり、本体からは消える
- **通報は Amis 側** で持つ
- **体験版ゲスト・結末 (エンディング)・コインは廃止** する。フロントとの食い違いは `amiverse-docs` の `amis-workers.md` にまとめてある
- 本体の Account とセッションは **Hyperdrive で都度読むだけ** (D1 に写しは持たない)
- Amis では **コインを使わない**。利用の制限は週の原価上限とレート制限だけ
- 画像と OG 画像は **Amis 内で完結** させる (R2 は本体と同じバケットの `amis/` 配下)
- 最初から D1 で作り、ステージングで検証してから **一括で切り替える** (本体 MariaDB を経由する中間段階は作らない)

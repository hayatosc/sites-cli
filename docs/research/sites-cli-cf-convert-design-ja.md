# 設計: Cloudflare 向けプロジェクトを `sites deploy` 1コマンドで Sites に上げる

目的: wrangler 前提で作られたプロジェクトのディレクトリで `sites deploy` と打つだけで、変換・ビルド・公開まで終わる CLI にする。前提の調査結果は `chatgpt-sites-internal-tools-ja.md` と `reproduce-outside-codex-ja.md`。この文書は差異の洗い出しと、それを吸収する変換の設計。

## 対象とするプロジェクト像（v1）

- 単一 Worker（`main` エントリ＋fetch ハンドラ）: Hono 等のフレームワーク利用を含む
- 静的サイトのみ（`assets` のみで Worker なし）
- 上記＋ D1 / R2 バインディング、環境変数
- 対象外: Next.js 系（Vinext の専用経路がある）、複数 Worker の連携、monorepo 内の複数 wrangler 設定

## 差異の一覧と吸収方針

| 観点 | Cloudflare（wrangler） | Sites | 吸収方法 |
| --- | --- | --- | --- |
| 設定ファイル | `wrangler.jsonc` に全部入り | `.openai/hosting.json`（project_id / static / d1 / r2 / capabilities / plugins / connectors のみ） | CLI が wrangler を読んで hosting.json を生成する |
| エントリ | `main` の任意ファイル。依存込みで wrangler がバンドル | `dist/server/index.js` の単一 ESM（default export の fetch） | CLI が esbuild で単一ファイルにバンドルして配置する |
| 静的資産 | Workers Static Assets（`assets.directory`＋任意で ASSETS バインディング） | 静的型は宣言ディレクトリをそのまま配信。Worker 型は dist/ に置いて ASSETS 経由が前提 | 資産を dist/ へコピー。配信の実挙動は検証フェーズで確認し、必要なら配信ラッパーを自動生成する |
| D1 | `d1_databases`（database_name / database_id） | hosting.json の `d1` にバインディング名だけ。実DBは Sites 側で新規に用意される | バインディング名を引き継ぐ。**既存DBのデータは移らない**（新規・空）ことを明示する |
| D1 マイグレーション | wrangler の migrations_dir や drizzle フォルダなど流儀が混在 | `dist/.openai/drizzle/` の SQL をデプロイ前に自動適用 | プロジェクトの SQL を集めて同梱する。スキーマ変更のみが対象で、データ投入系は警告する |
| R2 | `r2_buckets`（bucket_name） | hosting.json の `r2` にバインディング名だけ。実バケットは新規 | バインディング名を引き継ぐ。**既存バケットの中身は移らない** |
| KV / Durable Objects / Queues / Service Bindings / Hyperdrive / Vectorize / Workers AI 等 | バインディングで宣言 | **宣言手段がない（非対応）** | 事前検査で検出して止める。一覧と理由を表示し、変換を強行しない |
| Cron Triggers | `triggers.crons` | ない（定期実行は Automations という別仕組み） | 警告のみ。v1 では移行しない |
| 環境変数 | `vars` に平文、シークレットは `wrangler secret`（リポジトリ外） | ツール `update_environment_variables` で設定。ファイルには書かない | `vars` は自動で移す。シークレットは名前だけ検出して、対話入力か `--env-file` で受け取る |
| URL / ルート | `routes`、カスタムドメイン、workers.dev | `<slug>.chatgpt.site` に置き換わる | slug は wrangler の `name` を規則に合わせて正規化し、空きを確認する。カスタムドメインは後付けツールの案内だけ出す |
| 公開範囲 | workers.dev は実質公開、Access は別設定 | サイト単位の公開範囲。既定は非公開 | デプロイは既定で非公開（`deploy_private_site_version`）。`--public` 明示時のみ公開版 |
| ランタイム | Workers（compatibility_date、nodejs_compat 等のフラグ指定可） | Workers 互換だが上限あり: isolate 128MB、raw TCP 不可、WebSocket 可。互換フラグの指定手段なし | `node:` 組み込みモジュールへの依存を検査して警告する。TCP 系ライブラリは致命的として止める |
| 名前 | `name`（英数字・ハイフン） | slug: 小文字英字で開始、英数字と単一ハイフンのみ | 正規化して `check_slug_availability` で確認。衝突時は候補を提示 |

## コマンドの流れ（`sites deploy`）

1. **検出**: `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` があり `.openai/hosting.json` がなければ変換モード。両方あれば通常モード（変換済み）
2. **事前検査**: wrangler をパースし、上の対応表で「変換可能 / 警告 / 致命的」に分類して一覧表示。致命的ならここで停止する。`sites deploy --dry-run` はここ＋変換プレビューまで
3. **変換**: `.openai/hosting.json` を生成（d1 / r2 のバインディング名を継承）。`project_id` がなければ `create_site`（タイトルは wrangler の name、slug は正規化した name）して hosting.json に保存する。hosting.json は git 管理下に置く前提で、プロジェクトに `.openai/` が増えることを出力で明示する
4. **ビルド**:
   - Worker あり: esbuild で `main` を単一 ESM にバンドルし `dist/server/index.js` へ（`cloudflare:workers` 等は external）。package.json に build スクリプトがあればそちらを優先する分岐も置くが、既定は esbuild（通常の CF プロジェクトの build は wrangler 前提で dist を作らないため）
   - 資産あり: dist/ へコピー
   - Worker なし: 静的モード（hosting.static.directory に資産ディレクトリ）
   - `dist/.openai/hosting.json` を配置し、マイグレーション SQL を `dist/.openai/drizzle/` へ集約
5. **ソース同期**: プロジェクトが git 管理下ならそのまま。なければ CLI が初期化する（Sites の保存は commit 前提のため）。クレデンシャルを取得して push（トークンは環境変数経由の extraHeader、config に残さない）
6. **保存と公開**: `site.tar.gz`（dist/ のみ）を作り、files アップロード経由で `save_site_version {project_id, commit_sha, archive}` → `deploy_private_site_version`（`--public` で `deploy_site_version`）→ `get_deployment_status` をポーリング → URL を表示
7. **環境変数**: 公開後に `vars` 分を `update_environment_variables` で設定。シークレットは入力された分だけ同様に設定する

2回目以降は hosting.json の project_id を再利用し、同じ流れを差分デプロイとして回す。

## 検証フェーズで確定させること（未確定として残す点）

- Worker 型で dist/ に置いた静的資産が ASSETS バインディングで実際に配信されるか（Vinext の生成物ではその形だが、汎用 Worker での実挙動は未確認）。ダメなら「資産配信の薄いラッパーをエントリに被せる」案に切り替える
- D1 マイグレーションの適用順序と、wrangler 流儀（連番ファイル名）のままで受理されるか
- esbuild バンドル時の `cloudflare:workers` import や WASM / テキストモジュールの扱い

検証は、素の Worker＋静的資産＋D1 宣言の最小サンプルを自宅PCに作り、非公開サイトとして1回通して行う。実サイトが1つできるので、その実行は Hayato の go がある段階で。

## やらないこと（v1）

- 既存 D1 / R2 のデータ移行（必要なら別途エクスポート／インポートの手順を足す）
- Cron の Automations への移行
- カスタムドメインの自動設定（ツールの案内まで）
- Next.js / Vinext プロジェクトの変換

# sites CLI 仕様書

- **この文書は何か**: ChatGPT Sites へコマンド 1 つでデプロイする CLI（`sites`）の仕様。実装と利用の基準になる。
- **対象読者**: 実装者、利用者、レビュアー。
- **関連文書**: 実測の根拠は [verification-ja.md](./verification-ja.md)、一次資料は `docs/research/`。

## 1. 目的と範囲

### 1.1 目的

`cf`（Cloudflare CLI）と同じ使用感で、Sites のプロジェクトも、wrangler 前提の Cloudflare プロジェクトも `sites deploy` で公開できるようにする。Codex を介さず `https://chatgpt.com/backend-api/ps/mcp` へ直接 MCP 接続する。

### 1.2 対象

- 単一の Worker で構成されたサイト（D1 / R2 をバインディング名で利用）。
- 静的なファイルだけのサイト。
- `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` から変換できるプロジェクト。

### 1.3 対象外

- 複数 Worker、monorepo のワークスペース構成。
- KV / Durable Objects / Queues / Service Bindings / Hyperdrive / Vectorize / Workers AI。
- Next.js / Vinext など、フレームワーク固有の出力を前提とするもの（Sites 側の starter を使う）。
- ローカル開発サーバ（`sites dev`）とプレビューデプロイ（`sites preview`）。

## 2. 前提

### 2.1 認証

- Codex CLI の資格情報を流用する。**独自ログインは作らない**（`sites auth login` / `logout` / `list` は存在しない）。独自の資格情報ストアも作らない。
- 解決順は環境変数 `SITES_ACCESS_TOKEN`、次に `~/.codex/auth.json` の `tokens.access_token`。
- 期限切れ・401 のときは `tokens.refresh_token` で更新し、新しいトークンを `~/.codex/auth.json` へ原子的に書き戻す（`0600`、一時ファイル + rename、`auth_mode` / `OPENAI_API_KEY` / `tokens.account_id` は保持）。
- 認証の生存確認は MCP `initialize` の応答 `serverInfo.name == "plugin-runtime"` で行う。
- したがって利用前提は「Codex CLI にログイン済みであること」。

### 2.2 実装形態

- **単一ファイルの Node ESM（`.mjs`）**。実行時依存パッケージを持たない。
- そのため次のものは自前で実装する。
  - SSE の解析（`data:` 行の連結。JSON がそのまま返る場合も受ける）
  - JSONC のコメント・末尾カンマの除去
  - tar の作成（システムの `tar` を `-C <stage> -czf <archive> dist` で呼ぶ）
  - 進捗表示・色付け（`NO_COLOR` と TTY 判定のみ）
- Rolldown は同梱しない。Worker のバンドルは、プロジェクト側の `rolldown`（devDependency）または `npx rolldown` を使う。詳細は §7.3。
- 配布は npm パッケージ **`@hayatosc/sites`**（無スコープの `sites` は npm で取得済みのため）。`bin` 名は `sites` で、インストール後のコマンド名は `sites` のまま。`npx @hayatosc/sites deploy` のように npx からも実行できる。

### 2.3 実行環境

- Node.js 22.13 以上（`fetch`、`WebSocket` は使わない、`node:test` を使う）。
- `git` がインストールされていること（ソース同期に使う）。
- 対応 OS は Linux / macOS / Windows（`tar.exe` がある前提）。

## 3. CLI 仕様

### 3.1 出力

- **データ系コマンドの stdout は既定で JSON**（`cf auth whoami` などの cf のデータ系コマンドに合わせる）。
- `--human` を付けたときだけ表・箇条書きの人間可読出力にする。
- 進捗・警告・診断はすべて stderr。stdout には結果だけを出す。
- `--quiet` は stderr の進捗を止める（結果は変えない）。
- 成功時の JSON は次の封筒に統一する。

```json
{ "ok": true, "data": { }, "meta": { "duration_ms": 28431, "request_id": "req_…" } }
```

### 3.2 グローバルフラグ

| フラグ | 意味 |
| --- | --- |
| `--json` | JSON 出力を明示する（既定と同じ） |
| `--human` | 人間可読出力にする |
| `-q, --quiet` | stderr の進捗を止める（エラーは出す） |
| `--profile <name>` | 資格情報プロファイル（現状は Codex 認証を共有するため実質 1 つ） |
| `--no-color` | 色を無効化する（`NO_COLOR` も受け付ける） |
| `-y, --yes` | 対話確認をすべて承諾する（非 TTY では必須） |
| `-h, --help` | ヘルプを表示して終了（0） |
| `-v, --version` | バージョンを表示して終了（0） |

`cf` の `-z/--zone`、`--local`、`--persist-to`、`-m/--mode` は対応物がないため受け付けず、指定されたら終了コード 2 で拒否する（黙って無視しない）。

### 3.3 終了コード

| コード | 意味 | 代表例 |
| --- | --- | --- |
| 0 | 成功 | デプロイ完了、一覧取得成功 |
| 1 | 一般エラー | 予期しない例外、ローカル I/O 失敗、`status` が `failed` |
| 2 | 使い方の誤り | 未知のフラグ、引数不足、排他フラグの同時指定 |
| 3 | 認証エラー | `auth.json` なし、リフレッシュ失敗、401 |
| 4 | 通信・サーバエラー | ネットワーク断、5xx、タイムアウト、レート制限 |
| 5 | 事前検査の失敗 | 非対応バインディング、上限超過、未コミット変更 |
| 6 | 状態の競合 | 履歴の分岐、保存中の競合、slug 使用済み |
| 130 | 中断 | Ctrl-C（子プロセスを止め、一時ファイルを片付けてから終了） |

### 3.4 エラー形式

stderr に 3 行で出す。

```text
Error: Static-only site bundles cannot use runtime resource bindings, capabilities, or database migrations.
  hint: Remove "d1" from .openai/hosting.json, or drop "static" to build as a Worker site.
  docs: docs/implementation-plan-ja.md §5.2（archive 契約）
```

JSON 出力時は構造化する。

```json
{
  "ok": false,
  "error": {
    "code": "PREFLIGHT_STATIC_WITH_BINDINGS",
    "message": "Static-only site bundles cannot use runtime resource bindings, capabilities, or database migrations.",
    "hint": "Remove \"d1\" from .openai/hosting.json, or drop \"static\" to build as a Worker site.",
    "details": { "bindings": ["d1"] }
  }
}
```

- `code` は機械可読な固定文字列。`message` は API の文言をそのまま使ってよい。
- トークン・`upload_url`・`download_url` は出力しない。URL を出す場合はクエリを落とす。

### 3.5 コマンド一覧

| コマンド | 目的 | 対応する cf |
| --- | --- | --- |
| `sites auth whoami` | 認証状態の確認 | `cf auth whoami` |
| `sites init [dir]` | プロジェクト雛形の作成 | `cf init` |
| `sites create <slug>` | サイトの新規作成 | （なし） |
| `sites list` | サイト一覧 | （なし） |
| `sites info` | サイトの詳細 | （なし） |
| `sites deploy` | ビルド・同期・公開 | `cf deploy` |
| `sites status` | デプロイ状態 | `cf workers deployments list` |
| `sites logs` | Worker ログ | `cf logs retrieve` |
| `sites versions` | バージョン一覧・ロールバック | `cf workers versions list` |
| `sites env` | 環境変数の管理 | （なし） |
| `sites access` | 公開範囲の管理 | （なし） |
| `sites domains` | カスタムドメイン | （なし） |
| `sites analytics` | アクセス解析 | （なし） |
| `sites open` | ブラウザで開く | （なし） |
| `sites delete` | サイト削除 | `cf delete`（対象が異なる） |
| `sites doctor` | 前提と設定の診断 | （なし） |
| `sites cli search` | コマンド検索 | `cf cli search` |
| `sites docs search` | ドキュメント検索 | `cf docs search` |
| `sites schema` | API スキーマのダンプ | `cf schema` |

コマンドごとの差分は §8.2、実行環境の差分は §8.1 にまとめてある。

**`sites build` は存在しない。** ビルドは `sites deploy` の内部処理で、ビルドだけを確認したい場合は `sites deploy --dry-run` を使う（アップロードもソース同期もしない）。`cf build` のように単体で成果物だけ作る操作は提供しない。

## 4. コマンド仕様

### `sites auth whoami`

目的: どの資格情報で API を叩いているかを確認する。

```bash
sites auth whoami [--check]
```

`--check` は `initialize` を 1 回叩いて疎通まで確認する（既定はローカルの期限情報のみ）。

```json
{ "ok": true, "data": { "source": "~/.codex/auth.json", "account_id": "…", "expires_at": "2026-11-17T12:00:00.000Z", "refresh_token_present": true, "server": { "name": "plugin-runtime", "version": "0.1.0" } } }
```

```text
認証: ~/.codex/auth.json（Codex CLI と共通）
有効期限: 2026-11-17 12:00 JST
サーバ: plugin-runtime 0.1.0
```

終了コード: 0 / 3（認証なし・リフレッシュ失敗）/ 4（`--check` の通信失敗）。
エラー: `Error: Codex credentials not found at ~/.codex/auth.json` → `codex login` を実行する。

### `sites init [dir]`

目的: デプロイ可能な最小構成を作る。

```bash
sites init [dir] --template static|worker-esm [--force] [--no-git]
```

作られるもの: `.openai/hosting.json`（`project_id: null`）、`public/index.html` または `worker/index.js`、`package.json`（`build` スクリプトのみ）、`.gitignore`（`dist/` と `.sites/` を除外）。

終了コード: 0 / 2（未知のテンプレート）/ 5（既存ファイルあり、`--force` なし）。
cf との差分: `cf init` の `cloudflare.config.ts` / Vite 前提の雛形とは異なり、Sites のマニフェストと `dist/` 契約に合わせる。`--install` / `--package-manager` は無い（依存を持たない）。

### `sites create <slug>`

目的: サイトを作り、`project_id` を `hosting.json` に書き込む。

```bash
sites create <slug> [--title <title>] [--private|--public|--workspace] [--description <text>] [--dry-run]
```

処理: `check_slug_availability` → `create_site` → 戻り値の **`id`**（`appgprj_…`）を `project_id` として保存 →（戻り値に `source_repository_credential` が無ければ）`create_source_repository_write_credential`。**既定は private**（`custom`）。

```json
{ "ok": true, "data": { "project_id": "appgprj_…", "slug": "my-site", "access_mode": "custom", "url": "https://my-site.bouncy-leaf-5317.chatgpt.site", "source": { "remote_url": "https://git.chatgpt-team.site/…/….git", "branch": "main" } } }
```

```text
✓ サイトを作成しました: my-site
  URL: https://my-site.bouncy-leaf-5317.chatgpt.site
  公開範囲: private（自分のみ）
次の手順: sites deploy
```

終了コード: 0 / 3 / 4 / 6（slug 使用済み）/ 5（既に `project_id` がある）。
同一サイトを二重に作らないこと。`hosting.json` に `project_id` がある状態で `create` を呼んだら停止する。

### `sites list`

```bash
sites list [--limit 20] [--cursor <cursor>] [--role owner|editor|viewer] [--all]
```

`list_sites` を呼ぶ。0 件は成功（`items: []`）。`--all` は `limit 100` で `cursor` を辿る。

```json
{ "ok": true, "data": { "items": [{ "project_id": "appgprj_…", "slug": "my-site", "access_mode": "custom", "updated_at": "2026-11-07T03:12:44.000Z" }], "cursor": null } }
```

終了コード: 0 / 2（`--limit` 範囲外）/ 3 / 4（429 が 3 回再試行後も続く）。

### `sites info`

```bash
sites info [<project_id|slug>] [--mcp]
```

`get_site` に加え、必要なら `list_site_versions`（`limit 1`）と `list_custom_domains` を呼ぶ。`get_site` の `url` は `null` のことがある（`expected_url` は `create_site` のときだけ返る）。

終了コード: 0 / 2 / 3 / 4 / 5（`hosting.json` が無い）。

### `sites deploy`

目的: ビルド → 事前検査 → ソース同期 → パッケージ → アップロード → 保存 → デプロイを 1 コマンドで行う。

```bash
sites deploy [--dry-run] [--no-build-script] [--message <text>] [--tag <tag>] \
             [--private|--public|--workspace] [--env-file <path>] \
             [--no-source-sync] [--allow-dirty] [--allow-unsupported <kind,…>] [--timeout <sec>]
```

| フラグ | 意味 | 既定 |
| --- | --- | --- |
| `--dry-run` | ビルドと事前検査のみ。資格情報も不要 | off |
| `--no-build-script` | `package.json` の `build` を実行しない | off |
| `--message` | git のコミットメッセージ兼バージョン説明 | `Update Site source` |
| `--tag` | ローカル表示用の識別子（API には送らない） | なし |
| `--private` / `--public` / `--workspace` | デプロイ後の公開範囲 | 変更しない（新規は private） |
| `--env-file` | `KEY=VALUE` を読み、差分を反映 | なし |
| `--no-source-sync` | ソース同期を省略（通常は非推奨） | off |
| `--allow-dirty` | 未コミット変更を許容 | off |
| `--allow-unsupported` | 停止判定を警告へ格下げ | なし |
| `--timeout` | 完了待ちの秒数 | 300 |

内部手順は §5.1。出力例:

```text
[1/7] Preflight      ok (worker site, d1=DB)
[2/7] Build          ok (dist/server/index.js, 1.3 kB)
[3/7] Source sync    ok (6f4a231e → main)
[4/7] Package        ok (10.2 kB, 3 files)
[5/7] Upload         ok
[6/7] Save version   ok (v4)
[7/7] Deploy         publishing…
```

```text
✓ Deployed https://my-site.bouncy-leaf-5317.chatgpt.site (28.4s, version 4, deployment appgdep_…)
```

```json
{ "ok": true, "data": { "project_id": "appgprj_…", "version_id": "appgprj_…~appgver_…", "version_number": 4, "deployment_id": "appgdep_…", "status": "succeeded", "url": "https://my-site.bouncy-leaf-5317.chatgpt.site", "commit_sha": "6f4a231e…", "access_mode": "custom" } }
```

終了コード: 0 / 3 / 4 / 5 / 6 / 130。

| 状況 | `code` | 対処 |
| --- | --- | --- |
| 非対応バインディング | `PREFLIGHT_UNSUPPORTED_BINDING` | 削除する。警告扱いは `--allow-unsupported kv` |
| 未コミット変更 | `CONFLICT_DIRTY_TREE` | コミットするか `--allow-dirty` |
| 履歴の分岐 | `CONFLICT_DIVERGED` | `sites doctor --fix-git` の案内に従う（強制 push しない） |
| 上限超過 | `PREFLIGHT_ARCHIVE_TOO_LARGE` | 512 MiB 未満にする |
| デプロイ失敗 | `DEPLOY_FAILED` | `sites logs --errors-only` |
| タイムアウト | `DEPLOY_TIMEOUT` | `sites status <deployment_id>` |

注記: `--dry-run` は資格情報を要求しない（`cf build` と同じ思想）。`--public` を付けたデプロイは確認を挟む（`-y` で省略）。デプロイは取り消せない。

### `sites status`

```bash
sites status [<deployment_id>] [--watch] [--interval 3] [--timeout 300]
```

`get_deployment_status` を `pending` / `publishing` の間だけポーリングする。引数省略時は `.sites/state.json` の最新 ID。

```json
{ "ok": true, "data": { "deployment_id": "appgdep_…", "status": "failed", "url": null, "failure_message": "Uncaught SyntaxError: Unexpected end of input\n  at dist/server/index.js:3\n", "env_set_revision": 0 } }
```

終了コード: 0（`succeeded`）/ 1（`failed` / `error`）/ 4 / 5。
cf との差分: 状態名は `pending` → `publishing` → `succeeded` / `failed` / `error` で、`cf` の `active` とは語彙が違う。

### `sites logs`

```bash
sites logs [--since 30m] [--limit 100] [--errors-only|--all] [--follow]
```

`get_site_worker_logs` を呼ぶ。`--follow` は 5 秒間隔のポーリング（API に live-tail は無い）。イベント 0 件は成功。レート制限に当たったら間隔を 2 倍に広げる（最大 60 秒）。
終了コード: 0 / 3 / 4 / 130。

### `sites versions`

```bash
sites versions list [--limit 20] [--cursor <c>]
sites versions show <version_id>
sites versions rollback <version_id|--previous> [--yes]
```

`list_site_versions` / `get_site_version`。`rollback` は対象バージョンを現行の `access_mode` に応じた `deploy_*_site_version` で再デプロイする（新バージョンは作らない）。
終了コード: 0 / 4 / 5 / 6（公開中サイトに private 系を使おうとした → 400 `site_not_owner_only`）。

### `sites env`

```bash
sites env list
sites env get <KEY>
sites env set <KEY>=<VALUE> [--secret]
sites env unset <KEY>
sites env pull [--out .env]
sites env push [--env-file .env] [--dry-run]
```

`get_environment` / `update_environment_variables`。`set_values` は `{key, value, is_secret, type:"envvar"}`、削除は `remove`。
**変更は次のデプロイで反映される。`env set` は自動で再デプロイしない。** 秘密値は読み戻せない（常に `null`）。
終了コード: 0 / 2 / 3 / 4 / 5（秘密値の取得要求）。

### `sites access`

```bash
sites access show
sites access set --private|--public|--workspace [--allow-email <addr>]… [--wait] [--timeout 120]
```

`update_site_access`。反映には 40〜60 秒かかる（実測）。`--wait` は切り替わるまで最大 `--timeout` 待つ。
`workspace_all` は API が受理するが `available_access_modes` に出ないことがあり、実効性は組織構成に依存する（未確認）。
終了コード: 0 / 2 / 3 / 4 / 5（`--allow-email` と public の併用）。

### `sites domains`

```bash
sites domains add <hostname> [--wait] [--timeout 900]
sites domains list
sites domains refresh <hostname|custom_domain_id>
sites domains remove <hostname|custom_domain_id>
```

`add_custom_domain` → 検証レコードを表示 → `refresh_custom_domain_status` で `active` を確認。DNS レコードの作成は自動化しない。
終了コード: 0 / 3 / 4 / 5（ホスト名が不正）/ 6（他サイトで使用中）。

### `sites analytics`

```bash
sites analytics summary [--since 24h] [--view classic|list]
sites analytics events [--since 24h]
```

`get_site_analytics_overview`。境界は UTC-08:00 基準の 1 時間バケットに丸める（丸めないと `invalid_analytics_overview_query`）。新規イベントの反映は最大 1 時間。
終了コード: 0 / 2 / 3 / 4。

### `sites open`

`sites open [<project_id|slug>] [--path /foo] [--print]`。`--print` は URL を 1 行だけ stdout に出す。終了コード: 0 / 4 / 5。

### `sites delete`

`sites delete [<project_id|slug>] [--yes]`。`delete_site` を呼ぶ。**取り消せない。** 非 TTY では `--yes` 必須。削除後は `list_sites` から消える。
終了コード: 0 / 2 / 3 / 4 / 5。

### `sites doctor`

`sites doctor [--offline] [--fix-git] [--verbose]`。次の 12 項目を検査する。

| # | 検査 | 失敗時の意味 |
| --- | --- | --- |
| 1 | Node のバージョン（>= 22.13） | 実行環境が古い |
| 2 | `~/.codex/auth.json` の存在と期限 | 認証不能 |
| 3 | `initialize` の疎通（`plugin-runtime`） | エンドポイント変更・UA 不足 |
| 4 | `hosting.json` の妥当性 | ホワイトリスト違反 |
| 5 | `project_id` と API 側の一致 | 別アカウント・削除済み |
| 6 | wrangler の非対応要素 | 変換で停止する |
| 7 | `dist/` とマニフェストの整合 | アップロードで失敗する |
| 8 | 未コミット変更・履歴の分岐 | `commit_sha` が進まない |
| 9 | `git` の有無 | ソース同期不能 |
| 10 | `package.json` の `build` | ビルド不能 |
| 11 | 直近の 429 | 一時的な失敗 |
| 12 | `.sites/state.json` と実デプロイの一致 | `status` が古い |

終了コード: 0（ok / warn のみ）/ 1（fail あり）。

### `sites cli search` / `sites docs search` / `sites schema`

```bash
sites cli search "<task>"       # コマンド候補を最大 5 件、JSON で
sites docs search "<question>"  # docs/ 配下の Markdown から該当節を返す
sites schema [<tool>]           # MCP ツールの入力スキーマをダンプ
```

`cf` はネストした `--help` 探索を禁じ、`cli search` を推奨している。`sites` も同じ方針を取る。終了コード: 0 / 2（クエリ空）/ 4（`schema` の通信失敗）。

## 5. デプロイ仕様

### 5.1 手順

1. プロジェクト解決（`hosting.json` → 無ければ §7 の変換）。
2. 事前検査（非対応バインディング、上限、未コミット変更、`commit_sha` の再利用）。
3. ビルド（`package.json` の `build`。無ければ静的はコピー、Worker は Rolldown）。
4. 成果物の検証（`dist/server/index.js` か `dist/index.html`、マニフェストの整合、単一 ESM 条件）。
5. `--dry-run` なら終了（0）。
6. 認証解決と `initialize`。
7. ソース同期（下記）。
8. tar 作成（root は `dist/`、リポジトリ外か git 管理外の `outputs/` に置く）。
9. アップロード 3 段階（下記）。
10. `save_site_version`（`archive` はオブジェクト、`commit_sha` は必須）。
11. 公開範囲に応じて `deploy_private_site_version`（`custom`）か `deploy_site_version`（それ以外）を選ぶ。
12. `get_deployment_status` を終端までポーリング。

ソース同期: `git init --initial-branch <branch>` → `ls-remote` → `fetch --no-tags` → 作業ツリーのコピーを重ねる → コミット（`Update Site source`）→ `push` → `ls-remote` で一致確認 → `status --porcelain` が空であることを確認。一致しなければ「Site source changed while saving」で終了コード 6。

認証付き git の作法:

- `GIT_TERMINAL_PROMPT=0`、`-c credential.helper= -c http.extraHeader= -c http.followRedirects=false`
- トークンは `--config-env=http.<remote_url>.extraHeader=SITES_GIT_AUTHORIZATION` で渡す（argv に出さない）。env の値は `Authorization: Bearer <token>`。
- stderr はトークン文字列を `[redacted]` に置換してから表示する。
- 非 HTTPS の remote、資格情報入り URL、期限切れトークンは拒否する。

アップロード 3 段階:

1. `POST /backend-api/files`（`file_name` / `file_size` / `use_case:"codex"` / `codex_connector_id` / `codex_action_name` / `codex_model`）→ `file_id` と `upload_url`。
2. `PUT <upload_url>`（`x-ms-blob-type: BlockBlob`、認証ヘッダ無し）→ 201。502/503/504 は最大 5 回再試行。
3. `POST /backend-api/files/<file_id>/uploaded` → `status: success` または `retry`（250 ms 間隔で最大 30 秒）→ `{ download_url, file_id, mime_type, file_name, file_size_bytes }`。

`upload_url` はログに出さない。`archive` にはこのオブジェクトを渡す（文字列 `sediment://…` は `Expected type ['object']` で拒否される）。

### 5.2 archive 契約

- ルートは `dist/` 固定。中身は `dist/server/index.js`（Worker）または `dist/index.html`（静的）と `dist/.openai/hosting.json`、必要なら `dist/.openai/drizzle/`。
- シンボリックリンク・特殊ファイルは不可。
- 静的サイトでは manifest の `static.directory` を `"dist"` に書き換えて同梱する。
- Worker サイトに `static` を残すのはエラー。静的サイトに `d1` / `r2` / `capabilities` / マイグレーションを併記するのもエラー（保存は通るがデプロイが失敗する）。
- 上限は 512 MiB（536,870,912 B）。tar 前に合計サイズで検査する。

### 5.3 バージョンと `commit_sha`

- `save_site_version` は `commit_sha` で重複排除する。**同じ commit で別の archive を保存すると、古いバージョンがそのまま返る**（実測）。成果物が変わったら空コミットで sha を進める。
- バージョン ID は `appgprj_…~appgver_…` 形式。`version_number` は 1 から単調増加。
- ソースの push は保存の前提条件。push していないと `repository_branch_not_found` で失敗する。

### 5.4 状態遷移

`deploy_*` の戻り値は `status: pending`、`url: null`。ポーリングで `pending` → `publishing` → `succeeded`（または `failed` / `error`）。実測では 0.6〜10 秒で完了した。終端は `succeeded` で、`deployed` ではない。

### 5.5 失敗時

`status: failed` になると `url` は `null` で、`failure_message` に生のエラーが入る。

| 失敗の種類 | `failure_message` の例 |
| --- | --- |
| 構文エラー | `Uncaught SyntaxError: Unexpected end of input\n  at dist/server/index.js:3\n` |
| 未解決 import | `Uncaught Error: No such module "dist/server/missing-module.js".\n  imported from "dist/server/index.js"` |
| SQL エラー | `no such table: v: SQLITE_ERROR` |
| static + バインディング | `Static-only site bundles cannot use runtime resource bindings, capabilities, or database migrations. …` |

`status` コマンドはこの文字列をそのまま表示し、終了コード 1 を返す。

## 6. プラットフォーム仕様

### 6.1 接続

- エンドポイント: `POST https://chatgpt.com/backend-api/ps/mcp`。
- 必須ヘッダ: `Authorization: Bearer <access_token>`、`Content-Type: application/json`、`Accept: application/json, text/event-stream`、`X-OpenAI-Product-Sku: codex`、`originator: codex_cli_rs`、`User-Agent: codex_cli_rs/<version> (Linux; x86_64) rust`。**UA が無いと Cloudflare が 403 を返す。**
- 応答は SSE（`event: message` + `data: {...}`）。JSON がそのまま返る場合もあるため両方を受ける。
- `initialize` は `protocolVersion: "2025-03-26"` を送る。`serverInfo` が `{"name":"plugin-runtime","version":"0.1.0"}`。
- ステートレス（`Mcp-Session-Id` は不要）。ツール呼び出しは `{"jsonrpc":"2.0","id":…,"method":"tools/call","params":{"name":"sites.x","arguments":{…}}}`。
- エラーは `isError: true` と `structuredContent.error`（`SitesConnectorError: …`）、`error_code`（`INVALID_ARGUMENT` / `CONFLICT` / `NOT_FOUND`）、`error_data.type` を返す。

### 6.2 マニフェスト（`.openai/hosting.json`）

| キー | 型 | 内容 |
| --- | --- | --- |
| `project_id` | string | `create_site` の `id`。作り直さない |
| `static` | object \| null | `{ "directory": "dist" \| "dist/client" \| "out" \| "build" \| ".output/public", "not_found_handling": "none" \| "404-page" \| "single-page-application" }` |
| `d1` | string \| null | D1 のバインディング名（例 `DB`） |
| `r2` | string \| null | R2 のバインディング名（例 `BUCKET`） |
| `capabilities` | array | `"mcp"` のみ |
| `plugins` / `connectors` | array | 予約 |

ホワイトリスト外のキーは保存時に `Invalid dist/.openai/hosting.json: Extra inputs are not permitted` で拒否される。秘密値は置かない。

### 6.3 成果物と配信

- Worker サイトでは `dist/client/` が資産のルート。`/hello.txt` → `dist/client/hello.txt`。`dist/` 直下のファイルは配信されない。
- `env.ASSETS` は宣言なしで常に注入され、`ASSETS.fetch(new Request("https://<site>/hello.txt"))` が 200 を返す。`ASSETS` を未使用でも `keys` に現れる。
- 静的サイトは `static.directory` 配下をそのまま配信する。`/index.html` は 307 で `/` に寄る。
- 非公開サイトへの匿名アクセスは 401（ChatGPT のサインイン画面）。`OAI-Sites-Authorization: Bearer <siwc_bypass_bearer_token>` を付けると本文を取得できる（`generate_siwc_bypass_token` で発行）。

### 6.4 実行環境の制約

| 項目 | 可否 | 備考 |
| --- | --- | --- |
| WebSocket | 可 | `wss://` で双方向。サブプロトコルの折り返しは Worker 側で行う |
| raw TCP（`cloudflare:sockets`） | 不可 | `connect()` は `Stream was cancelled.` で失敗 |
| WASM（実行時コンパイル） | 不可 | `WebAssembly.instantiate(): Wasm code generation disallowed by embedder` |
| `node:` 組み込み | 可 | `nodejs_compat` が有効（`join` / `sep` 等が動く） |
| isolate メモリ | 128 MB | 超過は実行時エラー |

### 6.5 D1

- `hosting.json` の `d1` にバインディング名を書くと `env.<name>` で使える。データは移行されない（新規 DB）。
- マイグレーションは `dist/.openai/drizzle/**.sql`。**Worker のアップロード前に適用される。**
- 適用順は**ファイル名の文字列順**。`1_` と `10_` を混在させると `10_` が先に走る。`0001_` のようにゼロ埋めする。
- 適用済みは `__appgarden_migrations(id, name, applied_at)` に記録され、同名は飛ばされる。
- `meta/_journal.json` が無くても適用される（順序の制御はファイル名のみ）。
- スキーマ変更のみ可（データのバックフィル不可）。追加カラムの既定値は定数、`NOT NULL` には非 NULL の定数既定値が必要。

### 6.6 環境変数とシークレット

- `update_environment_variables` で `set_values`（`{key, value, is_secret, type:"envvar"}`）と `remove` を渡す。戻り値は `revision`。
- **反映には再デプロイが必要。** 同じバージョンを `deploy_*` し直すと新しい revision が適用される。
- 秘密値は読み戻せない（`value: null`）。

### 6.7 公開範囲

- `update_site_access` の `access_mode` は `custom`（既定・自分のみ）/ `public` / `workspace_all`。
- 反映には 40〜60 秒かかる。変更直後は 401 が続く。
- 公開中は `deploy_private_site_version` が 400 `site_not_owner_only` になる。`access_mode` を見てデプロイツールを選ぶこと。
- `deploy_public_site_version` というツールは存在しない（`deploy_site_version` を使う）。

### 6.8 カスタムドメイン

サブドメイン:

| 種別 | 名前 | 値 |
| --- | --- | --- |
| CNAME（proxied） | `my-site.example.com` | `custom-domains.chatgpt.site` |
| TXT | `_openai-site-verification.my-site.example.com` | `openai-site-verification=…` |
| TXT | `_cf-custom-hostname.my-site.example.com` | `…` |

apex:

| 種別 | 名前 | 値 |
| --- | --- | --- |
| A | `example.com` | `162.159.143.30` |
| A | `example.com` | `172.66.3.26` |
| TXT | `_openai-site-verification.example.com` | `openai-site-verification=…` |
| TXT | `_cf-custom-hostname.example.com` | `…` |

検証は通常 30〜60 秒（実測 40 秒で `active`）。既存の apex レコードを壊さないこと。

### 6.9 ログとアナリティクス

- ログは pull 型（`get_site_worker_logs`）。`since_minutes` / `limit` / `errors_only` を指定する。
- アナリティクスの窓は UTC-08:00 基準の 1 時間バケットに整列させる。`view: "list"` では `request_traffic: null`。

### 6.10 上限と制限

- アーカイブ 512 MiB、isolate 128 MB。
- レート制限は明示されていない（30 回連続の `list_sites` で 429 は出なかった）。429 は指数バックオフで再試行する。
- ツール数は増減する（実測で 470 → 497）。`sites.*` の名前で呼ぶ。

## 7. 変換仕様（wrangler → Sites）

### 7.1 入力

探索順は `hosting.json` → `wrangler.jsonc` → `wrangler.json` → `wrangler.toml`。読み取るのは `name` / `main` / `assets.{directory,binding,not_found_handling}` / `d1_databases[]` / `r2_buckets[]` / `vars` / `migrations_dir` / `triggers.crons` / 非対応セクションの有無。

### 7.2 出力

- `.openai/hosting.json`（§6.2）。`name` は slug 候補とタイトルに使う。
- `dist/server/index.js`（Worker）または `dist/index.html`（静的）。
- `dist/.openai/drizzle/`（D1 を使う場合、`migrations_dir` からコピー）。

### 7.3 Rolldown バンドル

```js
await build({
  input: main,
  platform: "neutral",
  external: [/^cloudflare:/, /^node:/],
  plugins: [rejectBinaryAssets()],
  output: { file: "dist/server/index.js", format: "esm" },
});
```

- `cloudflare:workers` は Rolldown では警告付きで外部扱いになるが、`external` に明示する。
- `node:*` も外部化する（ホスト側は `nodejs_compat` 有効）。
- `.txt` / `.html` / `.json` は文字列としてインライン化し、`.wasm` とバイナリは例外にする。
- 出力検証: `export default` がある、import が `cloudflare:*` と `node:*` だけ、相対 import と `require(` が無い、`import.meta.url` によるファイル読み込みが無い。評価はしない。

### 7.4 変換規則

| wrangler | Sites | 備考 |
| --- | --- | --- |
| `name` | slug 候補 + `title` | 小文字化、英数字とハイフン以外を除去、先頭は英字 |
| `main` | Rolldown の入力 → `dist/server/index.js` | 単一 ESM 化 |
| `assets.directory` | `dist/client/` へコピー | `main` と併用可 |
| `assets.binding` | 無視（`ASSETS` 固定） | `ASSETS` 以外は警告 |
| `assets.not_found_handling` | `static.not_found_handling` | 静的のみ |
| `d1_databases[0].binding` | `d1` | 1 つだけ |
| `r2_buckets[0].binding` | `r2` | 1 つだけ |
| `vars` | 環境変数（デプロイ時に反映） | 秘密は別扱い |
| `triggers.crons` | 変換しない（`create_schedule`） | 警告 |
| `compatibility_date` / `_flags` | 無視 | 警告 |
| `routes` / `custom_domains` | 変換しない（`sites domains add`） | 警告 |
| `migrations_dir` | `dist/.openai/drizzle` の元 | 既定 `drizzle` |

### 7.5 停止と警告

停止（終了コード 5）: `kv_namespaces`、`durable_objects`、`queues`、`services`、`hyperdrive`、`vectorize`、`ai` / `browser`、`[[rules]]`、`.wasm` import、D1 が 2 つ以上、R2 が 2 つ以上、バインディング名が識別子でない、512 MiB 超過、単一 ESM 条件の違反。

警告（続行）: `assets.binding` が `ASSETS` 以外、`triggers.crons`、`compatibility_date` / `_flags`、`routes` / `custom_domains`、`.dev.vars` などの秘密、マイグレーションのゼロ埋め無し、`env.ASSETS` の参照（そのまま動く）。

`--allow-unsupported <kind>` は停止判定のうち指定した種別だけを警告へ格下げする。格下げしても該当コードは動かないため、レポートに「未変換」として残す。

### 7.6 変換レポート

```json
{
  "conversion": {
    "source": "wrangler.jsonc",
    "kind": "worker",
    "manifest": { "d1": "DB", "r2": null, "static": null, "capabilities": [] },
    "changed": ["main → Rolldown bundle", "d1_databases[0].binding → d1"],
    "warnings": [{ "code": "CONVERT_CRON_NOT_MIGRATED", "detail": "triggers.crons[0]: \"0 * * * *\"" }],
    "blocked": [],
    "outputs": ["dist/server/index.js", "dist/.openai/hosting.json"]
  }
}
```

停止したときは何も書き換えない（`hosting.json` を作らず、`dist/` も消さない）。停止理由は 1 件目で止めずに全部列挙する。

## 8. Cloudflare（Workers / cf）との比較

実装時に「cf と同じにすべきか、Sites の都合に合わせるか」を判断するための基準。左が Cloudflare 側の一般論、右が Sites の実測済みの挙動。

### 8.1 実行環境・機能

| 項目 | Cloudflare Workers（wrangler） | ChatGPT Sites | 実装での扱い |
| --- | --- | --- | --- |
| 設定ファイル | `wrangler.jsonc` / `wrangler.toml`、`cf` は `cloudflare.config.ts` | `.openai/hosting.json`（キーはホワイトリスト） | 変換する（§7）。未知キーは拒否される |
| バインディング | KV / DO / Queues / Service Bindings / Hyperdrive / Vectorize / AI / D1 / R2 | **D1 と R2 のみ**（バインディング名で指定） | D1/R2 以外は変換停止（§7.5） |
| 静的資産 | `assets.directory` + `env.ASSETS` | `dist/client/` を配信。`env.ASSETS` は**宣言なしで常に注入** | `assets` はそのまま移せる |
| ランタイム | `compatibility_date` / `compatibility_flags` で制御 | `nodejs_compat` が常に有効。compat 指定は不可 | 警告のみ（§7.4） |
| WebSocket | 可 | 可（`wss://` で双方向） | そのまま動く |
| raw TCP | `cloudflare:sockets` で可 | **不可**（`Stream was cancelled.`） | 変換停止・利用者に明示 |
| WASM | import して instantiate 可 | **不可**（`Wasm code generation disallowed by embedder`） | 埋め込みもしない（§7.5） |
| Cron | `triggers.crons` | **無し**（`create_schedule` / `offer_site_schedule`） | 警告。移行は手動 |
| 環境変数 | `vars` / `secrets`（`wrangler secret put`） | `update_environment_variables`（`is_secret` 付き） | `vars` は変換。秘密は入れ直し |
| 反映のタイミング | 次のデプロイで反映 | **次のデプロイで反映**（同じバージョンの再デプロイでも可） | `env set` は自動デプロイしない |
| カスタムドメイン | `routes` / `custom_domains` + DNS | `add_custom_domain` + 検証レコード（CNAME + TXT 2 本、apex は A 2 本 + TXT 2 本） | DNS は自動化しない |
| アクセス制御 | Cloudflare Access（Zero Trust） | `access_mode`（`custom` / `public` / `workspace_all`）、反映に 40〜60 秒 | `sites access` で扱う |
| デプロイ単位 | Worker の version + deployment | site version（`commit_sha` で重複排除）+ deployment | 同じ commit の再保存は古い内容を返す |
| 状態名 | `active` など | `pending` → `publishing` → `succeeded` / `failed` / `error` | API の語彙をそのまま出す |
| ロールバック | version / deployment を切り替え | 過去の `version_id` を再デプロイ（新バージョンは作らない） | `sites versions rollback` |
| ログ | `wrangler tail` / `cf logs retrieve` | pull 型（`since_minutes` / `limit` / `errors_only`） | ライブテールは無い |
| アナリティクス | GraphQL Analytics | overview API（UTC-08:00 基準の 1 時間バケット） | 窓を丸める |
| ローカル開発 | `wrangler dev` | **無し** | `sites dev` は作らない |
| プレビュー | preview URL / `cf previews deploy` | **無し** | `sites preview` は作らない |
| 上限 | Worker 10 MB（有料）、isolate 128 MB | アーカイブ 512 MiB、isolate 128 MB、D1 10 GB/サイト | tar 前にサイズ検査 |
| 認証 | `cf auth login`（OAuth、`~/.config/cloudflare/`） | 無し（**Codex の `auth.json` を共有**） | 独自ログインを作らない |
| CI からのビルド | `wrangler build` / `cf build`（資格情報不要） | ビルド専用 API は無い | `sites deploy --dry-run` で代替 |

### 8.2 CLI（cf との対応と差分）

| やりたいこと | cf | sites | 差分 |
| --- | --- | --- | --- |
| ログイン | `cf auth login`（ブラウザ / デバイス OAuth） | **無し** | Codex CLI にログイン済みであることが前提。`sites auth whoami` だけ提供 |
| 資格情報の確認 | `cf auth whoami`（JSON） | `sites auth whoami` | 同じく JSON。`--check` で疎通確認を追加 |
| プロファイル | `cf auth create/list/activate/delete` | `--profile` のみ | 実質 1 プロファイル |
| 雛形作成 | `cf init [dir]`（Vite + `cloudflare.config.ts`） | `sites init [dir] --template static\|worker-esm` | 作る中身が違う（Sites のマニフェスト） |
| ビルドのみ | `cf build` | **無し** | `sites deploy --dry-run`（成果物は残る） |
| デプロイ | `cf deploy`（`--dry-run` / `--prebuilt` / `--tag` / `--message` / `--secrets-file` / `--worker` / `--provision`） | `sites deploy`（`--dry-run` / `--no-build-script` / `--tag` / `--message` / `--env-file` / `--no-source-sync`） | `--prebuilt`→`--no-build-script`、`--secrets-file`→`--env-file`。`--worker` / `--provision` / `--containers-rollout` / `--dispatch-namespace` は非対応（終了コード 2） |
| デプロイ状態 | `cf workers deployments list` | `sites status`（`--watch`） | 状態名の語彙が違う |
| バージョン | `cf workers versions list` | `sites versions list/show/rollback` | `rollback` は Sites 固有 |
| ログ | `cf logs retrieve` / `cf o11y telemetry live-tail` | `sites logs --follow`（ポーリング） | ライブテールは無い |
| リソース作成 | `cf create`（KV / R2 / D1 など） | `sites create <slug>`（**サイト作成**） | 名前が同じで意味が違う。混同しない |
| 削除 | `cf delete`（リソース） | `sites delete`（サイト。取り消し不可） | 対象が違う |
| 一覧 | （なし） | `sites list` | Sites 固有 |
| 詳細 | （なし） | `sites info` | Sites 固有 |
| 環境変数 | `cf deploy --secrets-file` | `sites env list/get/set/unset/pull/push` | 独立コマンド。反映には再デプロイ |
| 公開範囲 | Cloudflare Access のポリシー | `sites access show/set` | Sites 固有の `access_mode` |
| ドメイン | `cf dns records` / `cf zones` | `sites domains add/list/refresh/remove` | DNS の作成は行わない |
| 解析 | （なし） | `sites analytics` | Sites 固有 |
| ブラウザ | （なし） | `sites open` | Sites 固有 |
| 診断 | `cf workers check` など | `sites doctor` | 認証・変換・git まで含む |
| コマンド発見 | `cf cli search` / `cf docs search` / `cf schema` | `sites cli search` / `sites docs search` / `sites schema` | 同じ思想（ネストした `--help` 探索を推奨しない） |
| 設定 | `cloudflare.config.ts`、`~/.config/cloudflare/` | `.openai/hosting.json`、`~/.config/sites/config.json` | 資格情報は置かない |
| 共通フラグ | `-q/--quiet`、`--json`、`--no-color`、`-y/--yes`、`-h`、`-v` | 同じ | `-z/--zone`、`--local`、`--persist-to`、`-m/--mode` は非対応（終了コード 2） |

### 8.3 どちらに寄せるかの基準

1. **名前と既定値は cf に合わせる**。`deploy` / `--dry-run` / `--message` / `--tag` / `-q` / `-y` は同じ意味で使う。
2. **Sites に概念が無いものは、黙って無視せずエラーで止める**。`--local` や `-z` を受けて別の動きをするより、終了コード 2 の方が事故が少ない。
3. **データ系の出力は JSON を既定にする**（cf のデータ系コマンドと同じ）。人間可読は `--human` の明示指定に限る。
4. **`--dry-run` は資格情報を要求しない**（`cf build` と同じ）。CI の検査はここで担保する。
5. **Sites 固有の概念（公開範囲・ドメイン検証・アナリティクス・サイト内 MCP）は cf に対応物を作らず、`sites` の独立コマンドにする**。
6. **危険な操作は cf より厳しくする**。`sites delete` は非 TTY で `--yes` 必須、`--public` 付きデプロイは確認を挟む。

## 9. 非対応事項

| 項目 | 理由 |
| --- | --- |
| KV / Durable Objects / Queues / Service Bindings / Hyperdrive / Vectorize / Workers AI | Sites にバインディングが無い（マニフェストの未知キーは拒否される） |
| Cron | 仕組みが無い。`create_schedule` / `offer_site_schedule` で代替する（削除 API は無い） |
| raw TCP | `connect()` が失敗する |
| WASM の実行時コンパイル | 埋め込みバイトからの instantiate が拒否される |
| `sites dev`（ローカル開発サーバ） | Sites 側に無い。`wrangler dev` を使う |
| `sites preview`（プレビュー配信） | プレビュー用のデプロイ種別が無い |
| CI からのビルドのみ実行 | `deploy --dry-run` で代替（成果物は残る） |
| Sites の認証 UI 操作（`cf auth login` 相当） | Codex の認証を共有する |
| DNS レコードの自動作成 | 検証レコードの提示まで。作成は利用者が行う |
| サイト内 MCP の疎通確認 | `/mcp` はリソース向け OAuth が必要で、CLI からは検証できない |

## 10. 未決定事項

1. **Rolldown の入手方法**: 依存なしの前提で、プロジェクト側の `rolldown` を使うか `npx rolldown` を呼ぶか。どちらも無い場合に「バンドルせず単一 ESM を要求する」へ落とすか。
2. **`doctor` の範囲**: 12 項目で足りるか。`--fix-git` が触ってよい範囲（作業用 remote の掃除までか、`fetch` までか）。
3. **ASSETS 変換の最終判断**: `assets.directory` + `main` を `dist/client/` へ移す変換を既定で有効にするか、`--with-assets` のような明示フラグにするか。
4. **`--tag` の保存先**: API にバージョンのタグが無いため、`.sites/state.json` に持つか、git のタグに写すか。
5. **`logs --follow` の上限**: ポーリング間隔の上限（60 秒）と、何時間まで追うか。
6. **`analytics` の既定窓**: 24 時間か 7 日か。バケット整列の基準（UTC-08:00）を利用者に見せるか。
7. **`workspace_all` の案内文**: 実効性が未確認のため、指定時に警告を出すか拒否するか。
8. **複数サイト運用**: 1 リポジトリで複数サイトを持つ構成（`sites/<name>/`）を許すか。
9. **`sites delete` 後の `project_id` の扱い**: `hosting.json` から自動で消すか、手動のままにするか。

判断はすべてオーナーが行う。配布形態は決定済み（§2.2）。実装は 1〜2 を先に決めないと着手できない。

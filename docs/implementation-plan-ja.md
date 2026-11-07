# sites CLI 実装計画

ChatGPT Sites へコマンド 1 つでデプロイする CLI（`sites`）の実装案。
本書は**調査と設計のみ**を目的とし、実装コードは含まない。サイトの作成・デプロイも行っていない。

- 対象リポジトリ: `~/ghq/github.com/hayatosc/sites-cli`
- 調査日: 2026-11-07
- 前提調査: `docs/research/` の 3 文書（内容は鵜呑みにせず、可能な限り一次情報で再確認した。相違点は本文に明記）

---

## 0. 根拠レベルの定義

本書の各主張には次のラベルを付ける。**「未検証」は、スキーマやソースから「こう動くはず」と推定したにすぎない項目**であり、実装前にオーナー承認を得て検証する必要がある。

| ラベル | 意味 |
| --- | --- |
| 実測 | この PC で実際にコマンドを実行し、出力を確認した |
| ソース確認 | 配布物（プラグイン 1.1.3 のスクリプト・雛形・手順書、`cf` の実装）を読んで確認した |
| 公式ドキュメント | 一次ドキュメント（Cloudflare `cf` ドキュメント等）を読んで確認した |
| 未検証 | 上記から推定したが、実行による確認はしていない（書き込み系は原則ここに落ちる） |

書き込み系（`create_site` / `save_site_version` / `deploy*` / 環境変数変更 / アクセス設定変更 / ドメイン追加 / 削除）は**一切実行していない**。

---

## 1. 結論サマリ

1. **Sites の実体は「Cloudflare Workers 上のホスティング + マニフェスト `.openai/hosting.json` + アーカイブ `dist/` のアップロード」**である。`cf` の `deploy`（ビルド → 検証 → アップロード → デプロイ）と同じ骨格を持ち、CLI の使用感を `cf` に寄せるのは現実的。
2. **バインディングは D1 と R2 の 2 種のみ**。KV / Durable Objects / Queues / Service Bindings / Hyperdrive / Vectorize / Cron Triggers はマニフェストに表現手段がなく、**wrangler プロジェクトからの変換では「事前検査で停止」**するのが正しい。
3. **Worker 型で `ASSETS` バインディングは使えない**（マニフェストに指定手段が無い）。ただし実測では `dist/client/` 配下のファイルは静的に配信される（`dist/` 直下は配信されない）。これは starter の README が「保証しない」としている挙動なので、CLI は同梱を許可するが依存を推奨しない。
5. **認証は Codex の資格情報（`~/.codex/auth.json`）をそのまま使う**。`sites auth login` のような独自ログインは作らず、リフレッシュ時のみ書き戻す（`client_id` とローテーションは実測済み）。
6. **`cf build` に相当する独立コマンドは作らない**。ビルドは `deploy` の内部処理とし、ビルド + 検査だけの需要は `sites deploy --dry-run` で満たす（デブロイ一発で完結する `cf` の使用感を優先）。
4. **単一 ESM 化は Rolldown で行う**（実測）。`external: [/^cloudflare:/, /^node:/]` を明示すると 414 B の単一 ESM になり、import はその 2 種類だけになる。`nodejs_compat` はホスト側で**有効**（実測）。WASM はバンドルできても実行時コンパイルが禁止されているため不可（実測）。
5. `cf` との差分で埋めるべき穴は「ローカル開発サーバ・プレビュー・CI ビルド・ゾーン/DNS・暗号化に強い認証 UI」。逆に Sites 固有の「slug 予約確認・アクセス範囲・ドメイン接続・アナリティクス・DB ビューア・スケジュール」は `cf` に対応物がないので、`sites` 側で新規に設計する。
7. 実測で確定した「ソース push 必須」「`commit_sha` 重複排除」「状態は `succeeded`」は実装の前提条件（詳細は [verification-ja.md](./verification-ja.md)）。

---

## 2. Sites プラットフォームの実態

### 2.1 3 層構造

| 層 | 実体 | 役割 |
| --- | --- | --- |
| ローカル | `~/.codex/plugins/cache/openai-curated-remote/sites/1.1.3/` | 手順書（`skills/sites/SKILL.md`）とビルド/パッケージ用スクリプト、雛形 |
| ツール | MCP コネクタ `codex_apps`（`connector_20205bf7d4e99a89d7154bb849718324`） | `sites.*` 39 ツール。サイト作成・バージョン保存・デプロイ・環境変数・ログ等 |
| 実行 | Cloudflare Workers / D1 / R2 | 実際の配信。isolate あたり 128 MB、raw TCP 不可 |

`cf` が「ローカルでビルドし、Worker をアップロードする」のに対し、Sites は**ソースを git リポジトリへ push し、`dist/` を tar でアップロードし、バージョンをデプロイする**。CLI が隠蔽すべき複雑さはここに集中する。

### 2.2 発行パイプライン（一次情報で確認した順序）

```
1. sites.create_site({title, slug})                      ← 初回のみ。project_id と expected_url が返る
2. sites.create_source_repository_write_credential(...)   ← 初回のみ。remote_url / branch / token
3. git init / fetch / ff-only / commit / push             ← ローカル。ヘッダ認証
4. dist/ を組み立て、tar.gz 化                             ← ローカル
5. 添付ファイル 3 段階アップロード → `{download_url, file_id, …}`   ← HTTP（MCP の file param）
6. sites.save_site_version({project_id, commit_sha, archive})
7. sites.deploy_private_site_version / deploy_site_version({project_id, version_id})
8. sites.get_deployment_status({project_id, deployment_id}) ← pending/building/publishing の間だけポーリング
```

`save_version_and_deploy_private`（保存 + 非公開デプロイを 1 呼び出し）という合成ツールもあるが、**バージョン ID を CLI 側で保持したい・状態を表示したい**ので、`sites` は 6 と 7 を分けて呼ぶ。

### 2.3 アーカイブ契約（`prepare-site-build.cjs` / `package-site.mjs` の実装から）

- ルートは常に `dist/`。中身は
  - Worker 型: `dist/server/index.js`（単一 ESM）+ `dist/.openai/hosting.json`（+ `dist/.openai/drizzle/`）
  - 静的型: `dist/` 配下の成果物 + `dist/.openai/hosting.json`（`static.directory` は `"dist"` に**書き換えられる**）
- 同梱が必須: `.openai/hosting.json`。無いと失敗する。
- 禁止: シンボリックリンク・特殊ファイル（`assertRegularTree`）、プロジェクト外への出力、入力ディレクトリの内部への出力。
- 静的ビルドに `d1` / `r2` / `capabilities` / `drizzle/**.sql` が混ざると**ハードエラー**（"Static builds cannot use runtime bindings, capabilities, or database migrations"）。
- Worker ビルドに `static` が残ると**ハードエラー**（"Worker builds must not retain static configuration in dist/.openai/hosting.json"）。
- `static.directory` の許容値は `dist`, `dist/client`, `out`, `build`, `.output/public` の 5 つだけ。`not_found_handling` は `none` / `404-page` / `single-page-application`。
- アーカイブはチェックアウト外（または git 管理外の `outputs/`）に置く。`GIT_DIR` 等の環境変数は git 呼び出し時に除去される。

### 2.4 ソース同期プロトコル（`site-workflow.mjs` の実装から）

初回:

```bash
git init --initial-branch <branch>
git ls-remote --heads <remote_url> refs/heads/<branch>   # 空であることを確認
```

2 回目以降: `git fetch --no-tags` → 空なら `checkout -B`、遅れていれば `merge --ff-only`。分岐していれば
`Local and remote Site history diverged…` で停止（マージはしない）。

保存:

```bash
git add --all -- .
git write-tree
git diff --cached --quiet          # 差分なしなら commit しない
git -c user.name=Sites -c user.email=sites@users.noreply.openai.com commit -m "Update Site source"
git push <remote_url> <head>:refs/heads/<branch>
git ls-remote --heads <remote_url> refs/heads/<branch>   # 一致確認
git status --porcelain                                   # クリーン確認
```

認証は**トークンを argv に載せない**：

```bash
GIT_TERMINAL_PROMPT=0 \
SITES_GIT_AUTHORIZATION="Authorization: Bearer <token>" \
git -c credential.helper= -c http.extraHeader= -c http.followRedirects=false \
    --config-env=http.<remote_url>.extraHeader=SITES_GIT_AUTHORIZATION \
    push <remote_url> HEAD:refs/heads/<branch>
```

`remote_url` は HTTPS のみ許可、userinfo・クエリ・フラグメントを含んではならない。トークンは stderr から `[redacted]` に置換する。

### 2.5 マニフェスト `.openai/hosting.json`

```jsonc
{
  "project_id": "appgprj_...",     // create_site の "id"。再作成しない
  "static": {                       // Worker 型では「キーごと省略」
    "directory": "dist",
    "not_found_handling": "single-page-application"
  },
  "d1": null,                       // 使うなら "DB" などバインディング名（文字列）
  "r2": null,                       // 同上
  "capabilities": ["mcp"],          // 任意
  "plugins": [],                    // 任意
  "connectors": []                  // 任意
}
```

- `d1` / `r2` は**バインディング名**。`wrangler.jsonc` の `database_id` や `bucket_name` は使わない（Sites 側がプロビジョニングする）。
- secrets はここに書かない。環境変数はツール（`update_environment_variables`）で設定する。

---

## 3. 「できること・できないこと」対応表

対象は依頼で指定された全項目。**判定は「Sites 上で、`sites` CLI 経由で実現できるか」**の意味で付けた。

| 項目 | 判定 | 根拠レベル | 根拠・補足 |
| --- | --- | --- | --- |
| D1 | 可（1 サイト 1 バインディング） | ソース確認 + 公式ドキュメント | `hosting.json` の `d1` にバインディング名。雛形 `db/index.ts` が `env.DB` を使う。上限 10 GB/サイト |
| R2 | 可（1 サイト 1 バインディング） | ソース確認 | `hosting.json` の `r2`。`cloudflare-env.d.ts` に `BUCKET?: R2Bucket` |
| KV | 不可 | ソース確認 | マニフェストに KV を表現するフィールドが無い。`prepare-site-build` は未知キーを検査しないが、ホスト側が解釈しない |
| Durable Objects | 不可 | ソース確認 | 同上。DO 名前空間の指定手段が無い |
| Queues | 不可 | ソース確認 | 同上（producer/consumer とも不可） |
| Cron（`triggers.crons`） | 不可（代替あり） | ソース確認 | マニフェストに triggers が無い。代わりに `create_schedule`（クラウドタスク）がある。wrangler 変換時は警告 + 続行可否フラグ |
| Service Bindings | 不可 | ソース確認 | 同上。単一 Worker のみ |
| Hyperdrive | 不可 | ソース確認 | 同上（TCP 前提でもあり §raw TCP も不可） |
| WebSocket | 可（推定） | 未検証 | Workers ランタイムの `fetch` で `Upgrade: websocket` を返す方式。Sites 側で遮断する記述は見つからないが実測なし |
| raw TCP | 不可 | ソース確認 | 手順書に "raw TCP is unavailable" と明記。`node:net` の接続も不可 |
| `node:` 組み込み | 可 | **実測** | ホスト側ビルドで `nodejs_compat` が有効（`node:path` の `join`/`sep` が動作）。Rolldown では `node:*` を external にして import を温存する（実測）。事前検査は警告に留める |
| WASM | **不可** | **実測** | base64 埋め込みで単一 ESM にはできる（Rolldown の `load` フックで実測）が、実行時に `WebAssembly.instantiate(): Wasm code generation disallowed by embedder` で 500。ランタイムのコード生成が禁止されている。`.wasm` import は事前検査で**停止**する |
| 静的資産の配信（`ASSETS` バインディング） | **不可** | ソース確認 | マニフェストに指定手段が無い。`assets` 付き wrangler は変換時に停止 |
| 静的資産の配信（`dist/client`） | 可（実測）だが契約外 | **実測** | Worker 型でも `dist/client/*` は 200 で配信され、`dist/*` 直下は配信されない。ただし starter の README は単体アセットを置くなと明記しており、保証された契約ではない。CLI は同梱を許可しつつ警告しない程度に留める |
| 静的サイト配信 | 可 | ソース確認 | `static.directory` + `not_found_handling`。`dist/` へ正規化される |
| 環境変数 | 可 | **実測** | `update_environment_variables.set_values[{key,value,is_secret,type:"envvar"}]` → `revision` が増える。反映には**再デプロイが必要**（同一 `version_id` の再デプロイで反映されることを実測） |
| シークレット | 可 | ソース確認 | 同ツールの `is_secret: true`。取得 API は無いので CLI は値を再表示しない |
| カスタムドメイン | 可 | **実測** | `add_custom_domain` が CNAME ターゲット + **TXT 2 本**（`_openai-site-verification`, `_cf-custom-hostname`）を返す。proxied CNAME + TXT で約 40 秒後に `active/active/active` |
| 公開範囲 | 可 | ソース確認 + 実測（既定値） | `update_site_access.access_mode` = `public` / `workspace_all` / `custom`（+ メール・グループ許可リスト）。作成直後の `get_site` は `access_mode: "custom"` で、匿名アクセスは 401（実測） |
| D1 マイグレーション適用順序 | 可 | **実測** | journal 順に適用され、適用済みは再実行されない（0000 適用 → 行 insert → 0001 適用で行が保持された）。Worker アップロード前に適用される |
| マイグレーションのファイル名規則 | 可（drizzle-kit 準拠） | ソース確認 | `drizzle/NNNN_name.sql` + `drizzle/meta/_journal.json`。`dist/.openai/drizzle` へコピーされる。順序は journal |
| 単一 ESM 化（Rolldown）と `cloudflare:workers` | 可 | **実測** | `external: [/^cloudflare:/, /^node:/]` を指定。未指定でも Rolldown は警告して external 扱いにする（esbuild はエラー）。バンドル後の import は `cloudflare:workers` と `node:*` のみになる |
| サイト内 MCP サーバ | 可 | ソース確認 | `capabilities: ["mcp"]` + `POST /mcp`（stateless JSON-RPC、MCP 2026-07-28） |
| アナリティクス | 可 | ソース確認 | `get_site_analytics_overview` / `list_site_analytics_events` / `query_site_analytics_event` |
| ログ | 可（pull のみ） | 実測（形状） | `get_site_worker_logs({since_minutes, limit, errors_only})` は Cloudflare のイベント形式（`$metadata`, `source.message`, `$workers.event`）。例外は `source.exception.stack` に入る。`--follow` はポーリング実装 |
| 定期実行 | 可（Sites 流） | ソース確認 | `create_schedule` / `validate_suggested_schedule`。cron 式ではなく「タスク + リクエスト ID」 |
| バージョン切り戻し | 可 | ソース確認 | `list_site_versions` → `deploy_site_version(version_id)` |
| サイト削除 | 可 | **実測** | `delete_site` は `{project_id, was_deleted: true}` を返す。取り消し不可。削除後は `list_sites` から消え、`get_site` は 404 |
| 一覧・所属 | 可 | **実測** | `list_sites` は `{items, cursor}`。作成後は 1 件、削除後は `{items: [], cursor: null}` |
| slug 空き確認 | 可 | 実測 | `check_slug_availability("sites-cli-probe")` → `{available:true, status:"available"}` |
| ローカル実行（dev） | 不可 | ソース確認 | Sites 側にローカル実行基盤は無い。wrangler プロジェクトなら `wrangler dev` を案内 |
| プレビュー環境 | 不可 | ソース確認 | バージョンは保存できるが、公開 URL を持つのはデプロイ済みのみ |

### 3.1 実測で確定した挙動（再現手順つき）

**a) 認証付き MCP 呼び出し**

```bash
TOKEN=$(jq -r .tokens.access_token ~/.codex/auth.json)
curl -sS -X POST https://chatgpt.com/backend-api/ps/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-OpenAI-Product-Sku: codex" \
  -H "originator: codex_cli_rs" \
  -H "User-Agent: codex_cli_rs/0.166.0 (Linux; x86_64) rust" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sites.list_sites","arguments":{"limit":5}}}'
```

- **`User-Agent` が無いと Cloudflare が 403 を返す**。CLI の HTTP クライアントは UA を必ず設定する。
- 応答は `Content-Type` に反して **SSE**（`event: message` + `data: {...}`）。`data:` 行だけを JSON として読む。
- エラーは HTTP 200 + `result.isError: true` で返る。`structuredContent.error_code`（例 `INVALID_ARGUMENT`）と `error_data.code`（例 400）を見る。

**b) バンドラの可否（`/tmp/sites-fixture`、Rolldown 1.3.0）**

| 試行 | 結果 |
| --- | --- |
| `cloudflare:workers` を import（external 指定なし） | 警告 `Module not found, treating it as an external dependency` のうえ external 扱い（esbuild はエラー） |
| `external: ["cloudflare:workers", "node:*"]` | 414 B の単一 ESM。`import { env } from "cloudflare:workers";` が先頭に残る |
| `.wasm` / `.txt` を import（プラグインなし） | `[PARSE_ERROR] Invalid Character`（バイナリを JS として解釈） |
| `load` フックで base64 → `Uint8Array` を返す | 0.36 kB の単一 ESM、追加ファイルなし |
| `platform: "neutral"` + `node:fs` | `node:*` を external にしないと解決エラー。external なら import が温存 |

**c) 実行時の挙動（使い捨てサイト、詳細は [verification-ja.md](./verification-ja.md)）**

| 試行 | 結果 |
| --- | --- |
| ソース未 push で `save_site_version` | `CONFLICT: repository_branch_not_found` |
| 同一 `commit_sha` で別 tar を保存 | 既存バージョンが返り、内容は更新されない（重複排除） |
| `archive` に `"sediment://…"` 文字列 | `INVALID_ARGUMENT: Expected type ['object'], got str` |
| デプロイ状態 | `pending` → `publishing` → `succeeded`（終端は `succeeded`） |
| Worker + `node:path` | 200（`nodejs_compat` 有効） |
| Worker + インライン WASM | 500 `Wasm code generation disallowed by embedder` |
| Worker + `dist/client/extra.txt` | 200（`dist/client` は配信される） |
| 2 版のマイグレーション | journal 順に適用、適用済みはスキップ、データ保持 |
| 環境変数の変更のみ | 反映されない。同一バージョン再デプロイで反映 |
| カスタムドメイン | CNAME + TXT 2 本で約 40 秒後に `active` |
| アップロード上限 | 512 MiB ちょうど可、+1 B で `file_too_large` |
| レート制限 | `list_sites` 30 連続で 429 なし（約 0.95 秒/回） |

---

## 4. `cf` CLI との対応づけ

### 4.1 `cf` の設計原則（実測 + 公式ドキュメント）

1. **エージェント向け発見性**: ルートヘルプの冒頭で「`--help` を入れ子に辿るな」と明示し、`cf cli search` / `cf docs search` / `cf schema` を案内する。`sites` も同じ 3 点セットを用意する（タスク検索・ドキュメント検索・JSON スキーマ）。
2. **グローバルフラグを全コマンドに持たせる**: `-q/--quiet`, `--profile`, `-m/--mode`, `--local`, `--persist-to`, `-h`, `-v`。
3. **データ系コマンドは JSON 既定**: `cf auth list` / `cf auth whoami` は JSON を返す（`expiresAt` を含む）。
4. **`--dry-run` をデプロイに持たせる**: `cf deploy --dry-run` はビルド + 検証のみで資格情報不要。`sites` は独立した `build` コマンドを持たないため、ビルドだけ確認したい需要も `sites deploy --dry-run` が吸収する。
5. **設定は TypeScript**（`cloudflare.config.ts`）。`cf` は wrangler 設定を読まず、`cf migrate` での移行を強制する。
6. **資格情報はプロファイル単位**で `~/.config/cloudflare/` に保存。

### 4.2 コマンド対応表

| `cf` | `sites` | 対応の性質 |
| --- | --- | --- |
| `cf auth login`（device/browser） | — | **非対応**。Codex のトークンをそのまま使う（`sites auth whoami` で状態確認） |
| `cf auth whoami` | `sites auth whoami` | 同等（JSON）。`initialize` 呼び出しで疎通確認も行う |
| `cf auth list` / `logout` | — | **非対応**。資格情報は Codex のものが唯一（プロファイル概念を持たない） |
| `cf init [dir]` | `sites init [dir] --template static\|worker-esm` | 同等（雛形はプラグインの starter を流用） |
| `cf build [--dry-run]` | — | **非対応**。ビルドは `deploy` の内部処理で、確認だけなら `sites deploy --dry-run` |
| `cf deploy [--dry-run] [--message] [--tag]` | `sites deploy [--dry-run] [--message] [--tag]` | 同等 + Sites 固有（バージョン保存・公開範囲）。`--dry-run` はビルド + 事前検査のみ |
| `cf deploy --secrets-file` | `sites deploy --env-file` | 同等（Sites は env ツール経由） |
| `cf workers versions list` | `sites versions list` | 同等 |
| — | `sites versions rollback <version>` | Sites 固有（`deploy_site_version`） |
| `cf workers deployments list` | `sites status` | 部分対応（直近デプロイの状態のみ） |
| `cf logs retrieve` / `cf o11y telemetry live-tail` | `sites logs [--follow]` | 部分対応（pull のみ、`--follow` はポーリング） |
| `cf create`（リソース作成） | `sites create <slug>` | 意味が違う。Sites はサイト作成 |
| `cf delete` | `sites delete` | 同等（`--yes` 必須） |
| `cf dev` | — | **非対応**。`wrangler dev` を案内 |
| `cf previews deploy` | — | **非対応**（プレビュー環境が無い） |
| `cf migrate` | — | **非対応**。`sites` は wrangler 設定をその場で読む |
| `cf cli search` / `cf docs search` / `cf schema` | `sites cli search` / `sites docs search` / `sites schema` | 同等（自前データで実装） |
| — | `sites info` / `env` / `domains` / `access` / `analytics` / `open` / `doctor` | Sites 固有 |

### 4.3 模倣する具体仕様

**グローバルフラグ**（`cf` に合わせ、足りないものだけ追加）

```
-q, --quiet            進捗・装飾出力を抑制（結果のみ）
    --json             JSON 出力（cf のデータ系既定に合わせた明示版）
    --profile <name>   資格情報プロファイル（既定 "default"）
    --no-color         ANSI 色を無効化
-y, --yes              確認プロンプトを省略
-h, --help
-v, --version
```

`cf` の `--local` / `--persist-to` / `-z` は Sites に対応概念がないため**採用しない**（受け取ったら「未対応」で exit 2）。

**出力の作法**

- 進捗・警告・エラーは **stderr**、結果は **stdout**。
- 既定は人間向け、`--json` は機械向け（`{"ok":true,...}` 封筒）。
- `--quiet` は人間向け出力のうち進捗行のみ抑制し、最終結果 1 行は残す。
- 破壊的操作（`delete`, `rollback`, `access set`）は `--yes` が無ければ TTY で確認、非 TTY では exit 2。

**エラー表示**（`cf` の 1 行サマリ + 詳細の方針を踏襲）

```
Error: Preflight failed: unsupported binding "MY_KV" (kv_namespaces)
  hint: Sites supports only D1 and R2 bindings. Remove the binding or use --allow-unsupported to continue without it.
  docs: https://…/sites/bindings
```

`--json` 時:

```json
{"ok":false,"error":{"code":"PREFLIGHT_UNSUPPORTED_BINDING","message":"...","hint":"...","details":{"binding":"MY_KV","kind":"kv_namespaces"}}}
```

**終了コード**

| code | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般エラー |
| 2 | 使い方の誤り（未知フラグ・必須引数不足・非 TTY での確認） |
| 3 | 認証エラー（トークン無効・期限切れ・更新失敗） |
| 4 | 通信/サーバエラー（5xx、タイムアウト、SSE 不正） |
| 5 | 事前検査・変換の失敗（未対応バインディング、静的/Worker 混在など） |
| 6 | 状態競合（git 分岐、保存中の変更検知） |
| 130 | Ctrl-C |

---

## 5. `sites` CLI 仕様

### 5.1 技術選定

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（ESM） | `cf` / wrangler と同じ。Rolldown の API を直接使える |
| 実行環境 | Node.js >= 22.13 | 雛形の `engines` と `cf` の要求に合わせる。`fetch` / `AbortSignal.timeout` を標準で使う |
| HTTP | 標準 `fetch` | 依存を増やさない。SSE は `response.body` を `TextDecoderStream` で読む |
| CLI パーサ | `commander` | サブコマンド + グローバルフラグ + ヘルプ生成が十分。自前実装は避ける |
| バンドラ | `rolldown` | 実測済み（1.3.0）。`cloudflare:workers` / `node:*` を external にしやすく、CLI 自身のバンドルにも同じものを使える |
| アーカイブ | `tar`（npm） | プラグインはシステム `tar` を呼ぶが、Windows での差異を避けるためライブラリ化 |
| TOML | `smol-toml` | `wrangler.toml` の読み取りのみ |
| JSONC | `jsonc-parser` | `wrangler.jsonc` のコメント・末尾カンマ対応 |
| ESM 検査 | `es-module-lexer` | 出力の import 一覧を検証（許可リスト方式） |
| 色 | `picocolors` | 小さく、`--no-color`/`NO_COLOR` 対応が容易 |
| テスト | `vitest` | 単体 + フェイク MCP サーバ |

**依存方針**: 実行時依存は上記 7 個まで。`wrangler` には依存しない（変換は自前、ビルドは `package.json` のスクリプトを実行）。

### 5.2 設定と状態

| パス | 内容 | 権限 |
| --- | --- | --- |
| `~/.codex/auth.json` | Codex の資格情報（`tokens.access_token` / `refresh_token` / `account_id`）。**読み取りと書き戻しのみ** | 0600（Codex が管理） |
| `~/.config/sites/config.json` | 既定プロファイル、既定の公開範囲、`api_base` | 0644 |
| `<project>/.openai/hosting.json` | `project_id` / `static` / `d1` / `r2` / `capabilities` | リポジトリ管理（コミットする） |
| `<project>/.sites/state.json` | 直近の `deployment_id` / `version_id` / `commit_sha` | git 管理外（`.gitignore`） |

`cf` の `~/.config/cloudflare/{config,state,registry}` にならい**プロジェクト状態を分離**する。ただし**資格情報は自前で持たない**。Codex が管理する `~/.codex/auth.json` を唯一の真実とし、`sites` は `~/.config/sites/config.json`（既定値）と `<project>/.sites/state.json`（進行状態）だけを持つ。プロジェクト識別子は `cf` の `cloudflare.config.ts` に相当するものとして `.openai/hosting.json` を唯一の真実とする。

### 5.3 認証

`sites` は**独自のログイン機構を持たない**。Codex がすでに持っている資格情報をそのまま使う。

```
$ sites auth whoami [--json]
✓ Codex credentials: hayato@example.com (account_id: 79…)
✓ MCP: plugin-runtime 0.1.0 (initialized)
  アクセストークン有効期限（推定）: あと 9 日
```

- 読み取り元は `~/.codex/auth.json`（`$CODEX_HOME/auth.json` があれば優先）。`tokens.access_token` を `Authorization: Bearer` に使う。
- `SITES_ACCESS_TOKEN` 環境変数があればそれを最優先（CI 用）。この場合リフレッシュも書き戻しも行わない。
- **`sites auth login` / `logout` / `list` は作らない**。資格情報の管理は Codex の責任範囲であり、二重管理は事故のもとになる。存在しないサブコマンドを案内しない（`sites auth --help` には `whoami` だけを出す）。
- 認証の検証は `initialize` を 1 回呼び、`serverInfo.name == "plugin-runtime"` を確認する。失敗時 exit 3。

**自動リフレッシュ（実測済み）**

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<auth.json の tokens.refresh_token>
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

- 応答: `{access_token, token_type, expires_in: 864000, scope, id_token, earliest_refresh_at, refresh_token}`。**リフレッシュトークンはローテーションされる**ので、返ってきた `refresh_token` / `id_token` を必ず保存する。
- 起動時に `last_refresh` + `expires_in` から余裕（24 時間）を引いた時刻を過ぎていれば更新する。401 を受けた場合も 1 回だけ更新して再試行する。
- 書き戻しは **一時ファイル + `rename`**（`mode 0600`）。`auth_mode` / `OPENAI_API_KEY` / `tokens.account_id` など未知のキーは保持し、`last_refresh` だけ更新する。書き戻しに失敗した場合は「トークンは更新されたが保存できなかった」と警告し、処理は続行する（次回また更新される）。
- 更新に失敗したら exit 3 で「`codex login` を再実行してください」と案内する。

### 5.4 コマンド詳細

以下、`<pid>` は `.openai/hosting.json` の `project_id`。

#### `sites init [dir] --template static|worker-esm`

- ローカル: プラグインの `templates/worker-esm-starter` 相当を展開し、`.openai/hosting.json` に `{"d1":null,"r2":null}` を書く。`worker-esm` は `dist/server/index.js` + `.openai/hosting.json` を出力する `build.sh` 相当も生成。
- MCP: 呼ばない（`project_id` は `sites create` で入れる）。
- 出力: `Created worker-esm project in ./my-site`。

#### `sites create <slug> [--title <t>] [--public|--workspace|--private]`

- ローカル: `check_slug_availability` で事前確認 → 正規化（下記）→ `create_site` → 返った **`id`**（= `project_id`）を `.openai/hosting.json` に**アトミックに**書き込む（temp + rename）→ `source_repository_credential` の `remote_url` / `branch` を `.sites/state.json` に保存（**`token` は保存しない**）。
- 出力:

```
✓ Slug "my-site" is available
✓ Created site: My Site
  project_id: appgprj_abc123
  url:        https://my-site.bouncy-leaf-5317.chatgpt.site
  source:     main → git.chatgpt-team.site/…/appgprj_abc123.git
  next:       sites deploy
```

- `expected_url` は`create_site` のときだけ返る（`get_site` では `null`）。URL はデプロイ完了まで確定しないため、出力では「予定」と明記する。

- slug 正規化: 小文字化 → 英数字とハイフン以外をハイフンに → 連続ハイフンを 1 つに → 先頭の非英字を除去 → 末尾ハイフン除去。空になったら exit 2。`--slug` 指定時は正規化せず検証のみ。

#### `sites list [--limit 20] [--cursor <c>] [--role owner|editor|viewer]`

- MCP: `list_sites`。ローカル処理なし。
- 出力（表）:

```
SLUG            TITLE          ACCESS     UPDATED
my-site         My Site        private    2026-11-07 10:12
demo            Demo           public     2026-11-06 18:40
```

#### `sites info [--project <id>]`

- MCP: `get_site`（`include_mcp_connection` は `--mcp` 指定時のみ）。
- 出力: `project_id` / `slug` / `title` / `access_mode` / `url` / `d1` / `r2` / `capabilities` / 直近デプロイ。

#### `sites deploy`

重要コマンド。**ビルドも deploy の内部で行う**（独立した `build` コマンドは持たない）。`cf deploy` と同じく、ビルド → 検証 → ソース同期 → アップロード → デプロイ → 状態確認の順で進み、各段階を 1 行で表示する。ビルドだけ確認したい場合は `--dry-run` を使う。

```
$ sites deploy --message "Fix header parsing" --tag v1.2.0

→ Preflight            ok (worker, d1=DB, r2=-)
→ Build                ok (dist/server/index.js, 41.2 kB)
→ Source sync          ok (a1b2c3d, 3 files)
→ Package              ok (site.tar.gz, 44.8 kB)
→ Upload               ok (file_9f2c…)
→ Save version         ok (version_7d1e…)
→ Deploy               ok (deployment_5c3a…)
✓ Deployed https://my-site.bouncy-leaf-5317.chatgpt.site  (28.4s)
```

フラグ:

| フラグ | 既定 | 説明 |
| --- | --- | --- |
| `--dry-run` | false | **ビルド + 事前検査のみ**。MCP を呼ばず、資格情報も不要。生成予定ファイル一覧と検査結果を表示する（`sites deploy --dry-run` でビルドのみ検証できる） |
| `--no-build-script` | false | `package.json` の `build` スクリプトを実行しない |
| `--message <m>` | 自動 | git コミットメッセージ。既定は変更ファイルの要約 |
| `--tag <t>` | なし | バージョンの識別子として表示・保存（`list_site_versions` のメモには使えないため `.sites/state.json` に保持） |
| `--private` / `--public` / `--workspace` | 設定 or `private` | デプロイ後の公開範囲。`deploy_private_site_version` と `deploy_site_version` の選択に使う |
| `--env-file <path>` | なし | `.env` を読み、差分を `update_environment_variables` で反映（反映後に再デプロイが必要な旨を警告） |
| `--no-source-sync` | false | git push をスキップする上級者向けフラグ。**既に同じ HEAD を push 済み**の場合のみ有効（未 push だと `save_site_version` が `repository_branch_not_found` で失敗する）。`--allow-dirty` との併用は exit 2 |
| `--allow-dirty` | false | 未コミット変更を許容（既定は exit 6） |
| `--allow-unsupported <kind,...>` | なし | 未対応バインディングを**落として**続行（明示時のみ） |
| `--timeout <sec>` | 300 | デプロイ状態のポーリング上限 |

内部シーケンス（実装順）:

1. `.openai/hosting.json` 解決。無ければ wrangler 変換モード（§6）。
2. ビルド（§6.5）: `package.json` の `build` 実行 → 成果物を `dist/` に組み立て → `dist/.openai/hosting.json` と `drizzle/` を同梱。
3. 事前検査（§6.3）を再実行。
4. `--dry-run` ならここで終了（exit 0/5）。**ここまで MCP を呼ばない。**
5. git: 未コミットがあれば `--allow-dirty` を要求。`remote_url` が未取得なら `create_source_repository_write_credential`（毎回取り直す。10 分で失効する）。
6. `git add -A` → 差分があればコミット。差分が無くても**成果物ハッシュが前回と違う場合は `--allow-empty` でコミットを作る**（同じ `commit_sha` では `save_site_version` が重複排除され、新しい内容が反映されないため）。push 後 `ls-remote` で一致確認。
7. `dist/` を tar.gz 化（一時ディレクトリ、チェックアウト外）。512 MiB を超えたら exit 2。
8. 添付 3 段階（§5.5）→ `{download_url, file_id, mime_type, file_name}` を組み立てる。
9. `save_site_version({project_id, commit_sha, archive})` → `version_id`。
10. 公開範囲に応じて `deploy_private_site_version` または `deploy_site_version` → `deployment_id`。
11. `get_deployment_status` を 1 秒間隔（上限 5 秒）で `pending | publishing` の間ポーリング。**`succeeded` で URL を表示**、`failed` / `error` で `failure_message` とログ取得を案内（exit 1）。
12. `.sites/state.json` 更新。

#### `sites status [deployment_id] [--watch]`

- MCP: `get_deployment_status`（引数省略時は `.sites/state.json` の直近 ID）。
- 出力: 状態・開始時刻・所要時間・URL・失敗理由。`--watch` は終端（`succeeded` / `failed` / `error`）までポーリング（Ctrl-C 可）。

#### `sites logs [--since 30m] [--limit 100] [--errors-only] [--follow] [--json]`

- MCP: `get_site_worker_logs({project_id, since_minutes, limit, errors_only})`。
- `--follow` は 3 秒間隔のポーリングで、取得済みの末尾（タイムスタンプ + メッセージのハッシュ）を除外して追記表示。**ストリーミングではない**ことをヘルプに明記。

#### `sites env list|get|set|unset|pull|push`

| サブコマンド | MCP | ローカル |
| --- | --- | --- |
| `list` | `get_environment` | 値はマスク（`is_secret` は `****`） |
| `get <key>` | `get_environment` | 非シークレットのみ表示 |
| `set KEY=VALUE [--secret]` | `update_environment_variables({set_values:[…]})` | `.env` があれば追記提案 |
| `unset KEY…` | `update_environment_variables({remove:[…]})` | — |
| `pull [--out .env.local]` | `get_environment` | シークレットは書かない（鍵名のみ `KEY=`） |
| `push <file>` | `update_environment_variables` | 差分のみ送信 |

いずれも「反映には再デプロイが必要」と表示し、`--deploy` を付けた場合のみ続けてデプロイする。

#### `sites versions list|show|rollback`

- `list`: `list_site_versions({project_id, limit, cursor})`。新しい順、既定 20 件。
- `show <version_id>`: `get_site_version`。
- `rollback <version_id>`: 確認 → `deploy_site_version` → 状態ポーリング。`--yes` 必須（非 TTY）。

#### `sites domains add|list|refresh|remove`

- `add <hostname>`: `add_custom_domain` → 返った CNAME ターゲットと**検証用 TXT 2 本**をそのまま貼れる形で表示する。

```
✓ Added sites-verify.example.com (status: pending)
  CNAME  sites-verify.example.com        → custom-domains.chatgpt.site  (proxied)
  TXT    _openai-site-verification.…     → openai-site-verification=vrpfsp_…
  TXT    _cf-custom-hostname.…           → 5944a80b-…
  next:  DNS を設定して `sites domains refresh sites-verify.example.com`
```

- `refresh <hostname>`: `refresh_custom_domain_status`（`custom_domain_id` は list から解決）。`status/provider_status/ssl_status` の 3 値を表示する。実測では約 40 秒で `active/active/active`。
- `remove`: `remove_custom_domain` + 確認。

#### `sites access [show|set]`

- `show`: `get_site` の `access_mode` と許可リスト。
- `set --mode public|workspace|custom [--email …] [--group …] [--viewer …] [--editor …]`: `update_site_access`。`custom` 以外で許可リストを渡したら exit 2（意味がないため）。

#### `sites analytics [summary|events] [--since 24h] [--json]`

- `summary`: `get_site_analytics_overview`。
- `events`: `list_site_analytics_events` / `query_site_analytics_event`（`start_time_ms` / `end_time_ms` を計算）。

#### `sites open`

- `get_site` で URL を取り、`$BROWSER` / `open` / `xdg-open` で開く。取得できなければ exit 1。

#### `sites doctor [--json]`

- ローカル診断: Node バージョン、Codex 認証の有効期限（`~/.codex/auth.json`）、`hosting.json` の妥当性、git 状態（remote/branch/未コミット）、Rolldown の解決可否、未対応バインディング、`drizzle` の有無。
- MCP: `initialize` のみ（疎通確認）。
- 出力は ✓/⚠/✗ の 3 段階。`✗` があれば exit 5。

#### `sites cli search "<task>"` / `sites docs search "<q>"` / `sites schema`

- `cf` のエージェント向け発見性を踏襲。`cli search` は組み込みのコマンド索引（名前・要約・主要フラグ）から最大 5 件を JSON で返す。
- `docs search` は `docs/` 配下の見出しを検索し、該当ファイル + 見出し + 1 行要約を返す。
- `schema` は全コマンドの引数・フラグ・終了コードを JSON Schema 風に出力（エージェントの自己修正用）。

### 5.5 添付アップロード（3 段階）

```
1) POST /backend-api/files
   {file_name, file_size, use_case:"codex", codex_connector_id, codex_action_name, codex_model}
   → {status:"success", file_id, upload_url}
2) PUT <upload_url>   (ヘッダ: x-ms-blob-type: BlockBlob、認証ヘッダは付けない)
   → 201。502/503/504 は最大 5 回再試行
3) POST /backend-api/files/<file_id>/uploaded  {}
   → {status:"success"|"retry", download_url, file_id, mime_type, file_name, file_size_bytes}
     を 250ms 間隔・最大 30 秒ポーリング
```

- `archive` には **3 の結果から組み立てたオブジェクト** `{download_url, file_id, mime_type, file_name}` を渡す。`sediment://` 文字列は不要（実測で `INVALID_ARGUMENT`）。
- `_meta["openai/fileParams"] = ["archive"]` を付ける。
- 上限 536,870,912 B（512 MiB）。超える場合は tar 前にサイズ検査して exit 2。実測で +1 B は `400 file_too_large`。
- 根拠レベル: **実測済み**（メタデータ作成 → PUT → 確定の 3 段階を小さい tar で通した）。`upload_url` は署名付きなのでログに出さない。

### 5.6 運用面

- **トークン**: 引数・ログ・git remote URL・`.sites/state.json` に残さない。`--verbose` でも Authorization ヘッダは伏せる。
- **リトライ**: GET 相当（`list_*`, `get_*`）は 429/5xx で最大 3 回（指数バックオフ + jitter）。`save_site_version` などの非冪等呼び出しは再試行しない。
- **冪等性**: `create_site` は `project_id` が既にある場合**呼ばない**（手順書の指示）。連打時の二重作成を防ぐため、`.sites/state.json` にロックファイル（`proper-lockfile` 相当の排他）を置く。
- **中断**: Ctrl-C で SIGINT を捕捉し、子プロセス（git / build）を終了、一時ディレクトリを削除、exit 130。
- **タイムアウト**: HTTP 30 秒、デプロイポーリング 300 秒（`--timeout` で変更）。
- **監査性**: `--json` 出力に `project_id` / `version_id` / `deployment_id` / `commit_sha` を含める。

---

## 6. wrangler プロジェクトの変換

### 6.1 対象と対象外

| 対象 | 条件 |
| --- | --- |
| 単一 Worker | `main` を持ち、`assets` を持たない |
| 静的サイト | `assets.directory` のみ（`main` なし） |
| D1 / R2 | バインディング名のみ移行（データ移行はしない） |
| 対象外 | 複数 Worker / monorepo、`assets` + `main` の併用、KV/DO/Queues/Service Bindings/Hyperdrive/Vectorize/AI、`wrangler.toml` の `[[rules]]`（カスタムローダ） |

### 6.2 検出

1. `.openai/hosting.json` があれば**変換しない**（Sites ネイティブプロジェクト）。
2. `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` を探す（優先順はこの順）。
3. `package.json` の `dev`/`build`/`deploy` スクリプトに `wrangler` が含まれるかも補助シグナルにする。
4. 検出時は「変換モード」で動作し、`--write-hosting-json` を付けた場合のみ `.openai/hosting.json` を生成する（既定はメモリ上のみ）。

### 6.3 事前検査チェックリスト

`--dry-run` でも必ず実行する。`✗` が 1 つでもあれば exit 5（`--allow-unsupported` で明示的に落とせるものを除く）。

| # | 検査 | 失敗時の扱い |
| --- | --- | --- |
| 1 | `main` が存在し、ファイルとして読める | ✗ 停止 |
| 2 | `main` が ESM（`import`/`export` を含む） | ✗ 停止（CJS は `require` 変換が不確実） |
| 3 | `main` が `export default { fetch }` を持つ（バンドル後に検証） | ✗ 停止 |
| 4 | `assets` と `main` の併用がない | ✗ 停止（ASSETS 不可） |
| 5 | `assets.directory` が存在する（静的モード時） | ✗ 停止 |
| 6 | `kv_namespaces` / `durable_objects` / `queues` / `services` / `hyperdrive` / `vectorize` / `ai` / `browser` / `analytics_engine` がない | ✗ 停止（`--allow-unsupported` で該当のみ除外可） |
| 7 | `triggers.crons` がない | ⚠ 警告（`--allow-cron-drop` で続行） |
| 8 | `d1_databases` が 1 件以下、`r2_buckets` が 1 件以下 | ✗ 停止（Sites は各 1 つ） |
| 9 | `d1_databases[].binding` が識別子として妥当（`[A-Za-z_][A-Za-z0-9_]*`） | ✗ 停止 |
| 10 | `compatibility_date` が存在する | ⚠ 警告（Sites 側では無視される） |
| 11 | `compatibility_flags` に `nodejs_compat` 以外が含まれる | ⚠ 警告 |
| 12 | `[[rules]]` / `build.upload.format` などの独自ローダ指定がない | ✗ 停止 |
| 13 | `main` の import がすべて解決できる（`cloudflare:*` / `node:*` を除く） | ✗ 停止（Rolldown は未解決を警告して external にするため、警告を検査で拾う） |
| 14 | `drizzle/` がある場合、`meta/_journal.json` が存在する | ⚠ 警告（無いと順序保証なし） |
| 15 | 生成物が 512 MiB 未満 | ✗ 停止 |
| 16 | `.wasm` / `.txt` などの特殊 import がない | ✗ 停止（WASM は実行時コンパイル不可。§3） |
| 17 | `assets` バインディング（`env.ASSETS`）を使っていない | ✗ 停止 |

### 6.4 変換マッピング

| wrangler | sites | 備考 |
| --- | --- | --- |
| `name` | `slug`（正規化）+ `title` | `check_slug_availability` で確認 |
| `main` | Rolldown のエントリ | `dist/server/index.js` へ |
| `assets.directory` | `static.directory` | 正規化して `dist` に |
| `assets.not_found_handling` | `static.not_found_handling` | 値はそのまま（`single-page-application` 等） |
| `d1_databases[0].binding` | `d1` | `database_id` は破棄 |
| `r2_buckets[0].binding` | `r2` | `bucket_name` は破棄 |
| `vars` | `update_environment_variables`（`is_secret:false`） | デプロイ時に反映 |
| `secrets`（`wrangler secret`） | `--env-file` / 対話入力 | 値は読めないため移行不可。鍵名のみ警告一覧に出す |
| `triggers.crons` | 変換せず警告 | 代替: `create_schedule` |
| `routes` / `custom_domains` | `sites domains add` を案内 | 自動追加はしない |
| `compatibility_date` / `flags` | 無視 | 警告のみ |
| `migrations_dir` | `drizzle/` を探索 | 既定 `drizzle` |
| `build.command` | `package.json` の `build` を実行 | `--no-build-script` で抑止 |

### 6.5 Rolldown 設定（実測に基づく）

```ts
// src/build/worker.ts の実装イメージ
import { build } from "rolldown";
import { readFile } from "node:fs/promises";

await build({
  input: main,
  platform: "neutral",
  external: [/^cloudflare:/, /^node:/],
  plugins: [
    {
      name: "reject-binary-assets",
      load(id) {
        if (/\.(wasm|node)$/.test(id)) {
          throw new Error(`Unsupported asset import: ${id} (WASM cannot run on Sites)`);
        }
        if (/\.(txt|html|json)$/.test(id)) {
          // テキストは JS 文字列としてインライン化する（別ファイルを出さない）
          return readFile(id, "utf8").then((s) => `export default ${JSON.stringify(s)};`);
        }
        return null;
      },
    },
  ],
  output: { file: "dist/server/index.js", format: "esm", sourcemap: false },
});
```

- `external` に `cloudflare:*` / `node:*` を入れる。未指定でも Rolldown は警告して external 扱いにするが、警告を検査で拾うために明示する（esbuild との差）。
- `.wasm` は**必ず停止**。base64 埋め込みでバンドルは通るが、実行時に `Wasm code generation disallowed by embedder` で 500 になる（実測）。
- `.txt` / `.json` は文字列としてインライン化する（`.wasm` のような別ファイル出力は単一 ESM を壊す）。
- 出力検証: 生成物を読み、`^import` 行が `cloudflare:*` と `node:*` だけであること、`require(` が無いこと、`import(` による相対パス参照が無いこと、`export default` があることを確かめる。**評価はしない**（`cloudflare:workers` を解決できない Node では import できない）。
- `nodejs_compat` はホスト側で有効（実測）なので、`node:*` の事前検査は**警告のみ**。ただし `node:net` / `node:dgram` など TCP/UDP は不可（raw TCP 不可）。
- ソースマップは既定で無効。`--sourcemap` は `inline` のみ許可（アーカイブに `.map` を増やさないため）。
- ビルドは `deploy` の内部処理。`--dry-run` でも同じ関数を通し、出力先を一時ディレクトリにして検査結果だけを返す。

### 6.6 停止条件（要約）

- Worker + `assets` の併用、`env.ASSETS` の利用
- `.wasm` / バイナリアセットの import（実行時コンパイル不可）
- 静的 + D1/R2/`capabilities`/マイグレーション
- 未対応バインディング（明示的な `--allow-unsupported` がない限り）
- ESM でない `main`、`export default { fetch }` が無い
- 未解決 import が残る
- 512 MiB 超
- git が分岐している / 差分が競合している

---

## 7. 実装単位

各単位は**コードを含む**（ドキュメントだけの単位は作らない）。「受入」はその単位だけで検証できる条件。

### U1. MCP クライアントと Codex 認証

- ファイル: `src/mcp/client.ts`, `src/mcp/sse.ts`, `src/auth/codex.ts`, `src/auth/refresh.ts`
- 内容: ヘッダ生成（UA 必須）、SSE パース、JSON-RPC エラー→ `SitesError` 変換、タイムアウト、リトライ。`~/.codex/auth.json` の読み取り、`SITES_ACCESS_TOKEN` の優先、OAuth リフレッシュ（`client_id=app_EMoamEEZ73f0CkXaXp7hrann`）、ローテーションされた `refresh_token` の書き戻し（tmp + rename、0600）。**独自の認証ストア・ログインコマンドは作らない。**
- 受入: フェイク SSE サーバに対して `initialize` / `tools/call` が通り、401 で 1 回更新して再試行する。書き戻し後に `auth_mode` / `OPENAI_API_KEY` が保持されることをテストで固定。UA 無しのリクエストを送らないことも固定。

### U2. CLI 骨格

- ファイル: `src/cli.ts`, `src/commands/index.ts`, `src/ui/output.ts`, `src/ui/errors.ts`, `src/exit.ts`
- 内容: `commander` のセットアップ、グローバルフラグ、人間/JSON 出力、終了コード、`--yes` の TTY 判定。
- 受入: 全コマンドが `--help` を出し、未知フラグで exit 2、`--json` で封筒形式になる。

### U3. プロジェクト解決と `hosting.json`

- ファイル: `src/project/resolve.ts`, `src/project/manifest.ts`, `src/project/state.ts`
- 内容: 探索、スキーマ検証（`static` の許可値、未知キーの警告）、アトミック書き込み、`.sites/state.json`、ロック。
- 受入: 不正な `static.directory` を exit 5 で拒否。`project_id` の二重書き込みが起きない。

### U4. wrangler 検出と事前検査

- ファイル: `src/convert/detect.ts`, `src/convert/jsonc.ts`, `src/convert/toml.ts`, `src/convert/preflight.ts`, `src/convert/mapping.ts`
- 内容: §6.2〜6.4 の実装。検査結果を `{level, code, message, hint}` の配列で返す。
- 受入: フィクスチャ 6 種（正常 Worker / 静的 / KV 入り / `assets`+`main` / 複数 D1 / cron 入り）で期待どおりの判定。

### U5. ビルド（静的）

- ファイル: `src/build/static.ts`, `src/build/layout.ts`
- 内容: `static.directory` の解決、`dist/` へのコピー、`hosting.json` の正規化、`drizzle` 同梱、シンボリックリンク検査。`deploy` から関数として呼ばれる（専用コマンドは無い）。
- 受入: SPA フィクスチャで `dist/index.html` と `dist/.openai/hosting.json` が生成される。`deploy --dry-run` で同じ検査が走る。

### U6. ビルド（Worker / Rolldown）

- ファイル: `src/build/worker.ts`, `src/build/bundle.ts`, `src/build/verify.ts`
- 内容: §6.5 の Rolldown 呼び出し、`external` の明示、`.wasm` の拒否、テキストのインライン化、出力検証（import 許可リスト、単一ファイル、`export default`）。
- 受入: `cloudflare:workers` + `node:path` を使うフィクスチャが通り、`.wasm` import を exit 5 で拒否。`assets` 併用も exit 5。

### U7. ソース同期

- ファイル: `src/git/sync.ts`, `src/git/credentials.ts`, `src/git/exec.ts`
- 内容: §2.4 のプロトコル。`GIT_DIR` 系の除去、HTTPS 検証、ヘッダ認証、トークン伏字、`ls-remote` 一致確認、diverged 検出。
- 受入: ローカルのベアリポジトリを remote に見立て、初回 push / 2 回目 / 分岐（exit 6）を再現。

### U8. アーカイブとアップロード

- ファイル: `src/package/archive.ts`, `src/upload/files.ts`, `src/upload/poll.ts`
- 内容: `tar` での `dist` 圧縮、チェックアウト外への出力、サイズ検査、3 段階アップロード、`{download_url, file_id, mime_type, file_name}` の組み立て。
- 受入: フェイク HTTP サーバで 3 段階（201 → success）を通し、502 で再試行、`retry` でポーリングする。

### U9. デプロイと状態

- ファイル: `src/deploy/run.ts`, `src/deploy/status.ts`, `src/deploy/rollback.ts`
- 内容: §5.4 のシーケンス（ビルドは内部処理）、公開範囲によるツール選択、`commit_sha` 重複排除を避ける空コミット、`archive` オブジェクトの組み立て、ポーリング、URL 表示、失敗時のログ案内。
- 受入: フェイク MCP で `pending → publishing → succeeded` を再現し、URL を出力。`failed` で exit 1 + ログ案内。同じ成果物で再実行しても `save` が新しいバージョンを返すことをテストする。

### U10. 情報系コマンド

- ファイル: `src/commands/{list,info,env,logs,versions,domains,access,analytics,delete}.ts`
- 内容: 各コマンドの MCP 呼び出しと表示。`env` のマスク、`logs --follow` の差分表示、`access` の引数検証。
- 受入: フェイク MCP のレスポンスで表・JSON の両方が一致する（スナップショットテスト）。

### U11. 初期化・診断・発見性

- ファイル: `src/commands/{init,doctor,open}.ts`, `src/discovery/search.ts`, `src/discovery/schema.ts`
- 内容: 雛形展開、`doctor`（Codex 認証・Rolldown・git・バインディング）、`cli search` / `docs search` / `schema`。
- 受入: `doctor` が認証切れ・未対応バインディング・git 未設定を検出。`schema` が全コマンドを列挙。

### U12. 配布と CI

- ファイル: `package.json`（`bin: {"sites": "./dist/bin.js"}`）, `.github/workflows/ci.yml`, `rolldown` による CLI 自身のバンドル設定（配布物も単一 ESM）
- 内容: CLI を単一 ESM にバンドル、Node 22/24 のマトリクスでテスト、`npm publish --dry-run` の検証。
- 受入: `node dist/bin.js --version` が動き、CI が緑。

**依存関係**: U1 → U2 → U3 → (U4, U5, U6) → (U7, U8) → U9 → U10 → U11 → U12。U4/U5/U6 は並行可。

---

## 8. テスト戦略

1. **単体**: 事前検査、slug 正規化、`hosting.json` 検証、Rolldown 出力検証、SSE パース、`archive` オブジェクト組み立て。
2. **フェイク MCP サーバ**: 実レスポンスを録画した JSON を返すローカル HTTP サーバ（`test/fixtures/mcp/*.json`）。**ネットワークに出ない**。
3. **git 統合**: 一時ディレクトリにベアリポジトリを作り、初回/更新/分岐を再現。
4. **スナップショット**: 各コマンドの人間向け出力と `--json` 出力。
5. **実機（任意・承認後）**: 書き込み系の検証は `docs/verification-plan-ja.md`（別途）に従い、専用の使い捨てサイトで行う。

---

## 9. 検証結果（2026-11-07 実施済み）

使い捨てサイト（`appgprj_6aee9644bcac8191ae99a192189125a1`）で実測した。詳細・証拠形状は [verification-ja.md](./verification-ja.md)。

| # | 事項 | 結果 | レベル |
| --- | --- | --- | --- |
| 1 | `create_site` の戻り値 | `id`（= `project_id`）/ `expected_url` / `source_repository_credential` | 実測 |
| 2 | ソース push の必須性 | 未 push では `CONFLICT: repository_branch_not_found` | 実測 |
| 3 | `archive` の形 | アップロード結果のオブジェクト。`sediment://` 文字列は不可 | 実測 |
| 4 | `commit_sha` の重複排除 | 同じ sha では新規バージョンが作られない | 実測 |
| 5 | デプロイ状態 | `pending → publishing → succeeded`（終端は `succeeded`） | 実測 |
| 6 | `nodejs_compat` | 有効 | 実測 |
| 7 | WASM | 実行時コンパイル不可（500） | 実測 |
| 8 | Worker の `dist/client` | 配信される（契約外） | 実測 |
| 9 | D1 マイグレーション | journal 順、適用済みはスキップ、データ保持 | 実測 |
| 10 | 環境変数 | 変更だけでは反映されず、再デプロイで反映 | 実測 |
| 11 | カスタムドメイン | CNAME + TXT 2 本、約 40 秒で `active` | 実測 |
| 12 | アップロード上限 | 512 MiB（+1 B で `file_too_large`） | 実測 |
| 13 | レート制限 | 30 連続呼び出しで 429 なし（約 0.95 秒/回） | 実測 |
| 14 | OAuth リフレッシュ | 成功、`expires_in: 864000`、RT ローテーション | 実測 |
| 15 | Rolldown の単一 ESM 化 | `external` 明示で 414 B、import は `cloudflare:*` / `node:*` のみ | 実測 |

**引き続き未検証**（実装時は安全側に倒す）: `ASSETS` バインディング、`public` / `workspace_all` の実挙動、apex ドメイン、WebSocket、`_journal.json` なしの適用順、失敗デプロイの `failure_message` 形状、アナリティクス / サイト内 MCP / スケジュール。

書き込み系の再検証が必要になった場合は、専用の使い捨てサイトを 1 つ作り、[verification-ja.md](./verification-ja.md) の手順に沿って行う。

---

## 10. リスクと代替案

| リスク | 影響 | 対応 |
| --- | --- | --- |
| 内部 API の仕様変更（`ps/mcp`、`files`） | CLI が動かなくなる | API バージョン検出（`initialize` の `serverInfo`）と、失敗時の明確なメッセージ。`--api-base` で切替可 |
| Codex の OAuth クライアント依存 | 認証が壊れる | `SITES_ACCESS_TOKEN` による CI 利用を第一級でサポート |
| `node:` 組み込みの対応範囲 | `node:net` / `node:dgram` など TCP/UDP が使えない | 事前検査で警告し、raw TCP は不可と明記 |
| ソース push の失敗 / 履歴分岐 | デプロイが止まる | `ls-remote` 一致確認、diverged は exit 6 で push 手順を提示 |
| 同一 `commit_sha` での保存無視 | 古い内容がデプロイされる | 成果物ハッシュが変わったら空コミットを作る（§5.4 手順 6） |
| 単一 ESM 制約（WASM・動的 import） | 一部プロジェクトが変換不能 | 事前検査で停止し、`wrangler` 併用を案内 |
| `cf` との UX 乖離 | 「同じ使用感」の要求を満たせない | §4.3 のフラグ・出力・終了コードを仕様として固定し、スナップショットで回帰防止 |
| 誤デプロイ（公開） | 情報露出 | 既定は非公開。`--public` は明示 + 確認。`access set` も確認必須 |

**代替案**: `cf` のプラグインとして実装する（`cf` の拡張点が非公開のため現実的でない）、`wrangler` のカスタムデプロイコマンドとして実装する（Sites の MCP 認証と噛み合わない）。**独立 CLI + MCP 直結が最も素直**。

---

## 付録 A. MCP 呼び出しの最小例

```jsonc
// 1) 疎通
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-03-26","capabilities":{},
  "clientInfo":{"name":"sites-cli","version":"0.1.0"}}}

// 2) 一覧
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"sites.list_sites","arguments":{"limit":20}}}

// 3) 保存（archive はオブジェクト）
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"sites.save_site_version",
  "arguments":{"project_id":"appgprj_…","commit_sha":"a1b2c3d",
    "archive":{"download_url":"https://…","file_id":"file_…",
      "mime_type":"application/x-tar","file_name":"site.tar.gz"}},
  "_meta":{"openai/fileParams":["archive"]}}}

// 4) デプロイ
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
  "name":"sites.deploy_private_site_version",
  "arguments":{"project_id":"appgprj_…","version_id":"appgprj_…~appgver_…"}}}
```

## 付録 B. 参考にした一次情報

- `~/.codex/plugins/cache/openai-curated-remote/sites/1.1.3/skills/sites/SKILL.md` および `references/*.md`
- 同 `scripts/{prepare-site-build.cjs, package-site.mjs, site-workflow.mjs, archive-path.mjs}`
- 同 `templates/{worker-esm-starter, vinext-starter}`
- `~/ghq/github.com/hayatosc/box-mcp/node_modules/cf`（`cf --help` 実測、`cf auth --help`、`cf deploy --help`、`cf cli search`）
- MCP 実測（`initialize` / `tools/list` / `sites.list_sites` / `sites.check_slug_availability` / エラー形状）
- esbuild 実測（`/tmp/sites-fixture`、esbuild 0.25.12、Node 24.21.0）
- Rolldown 実測（`/tmp/sites-fixture`、rolldown 1.3.0、Node 24.21.0）
- 実測検証（使い捨てサイト、2026-11-07）: [verification-ja.md](./verification-ja.md)
- `docs/research/` の 3 文書（本書で再確認できなかった箇所は「ソース確認（先行調査）」と明記）

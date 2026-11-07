# `sites` CLI 実測検証レポート

対象: [implementation-plan-ja.md](./implementation-plan-ja.md) §9「未検証事項」と依頼の 12 項目（round 1）、および §4 に残した 9 項目（round 2）。
実施日: 2026-11-07（JST）。実施者: オーナー承認済みの使い捨てサイトによる実測（round 2 は公開範囲の変更と書き込みを含む）。

## 0. 前提と方法

- 認証: `~/.codex/auth.json` の `tokens.access_token` をそのまま使い、`https://chatgpt.com/backend-api/ps/mcp` へ JSON-RPC を送った（実装予定の経路 A と同一）。
- 必須ヘッダ: `Authorization: Bearer <token>`、`Content-Type: application/json`、`Accept: application/json, text/event-stream`、`X-OpenAI-Product-Sku: codex`、`originator: codex_cli_rs`、`User-Agent: codex_cli_rs/0.166.0 (Linux; x86_64) rust`。
- 応答は `Content-Type: application/json` でも **SSE**（`event: message` + `data: {...}`）で返ることが多いが、round 2 では素の JSON が返ることもあった。パーサは両方を受ける必要がある。
- エラーは HTTP 200 + `result.isError: true`。詳細は `result.structuredContent.error_code` / `error_data.code`。
- 検証用スクリプトと成果物は `/tmp/sites-verify/`（リポジトリ外、コミットしない）。トークン・バイパストークンは表示も保存もしない（バイパスは 0600 の一時ファイルのみ）。

### 使い捨てサイト

| 項目 | 値 |
| --- | --- |
| slug | `sites-cli-verify-20261107` |
| project_id | `appgprj_6aee9644bcac8191ae99a192189125a1` |
| 既定 URL | `https://sites-cli-verify-20261107.bouncy-leaf-5317.chatgpt.site` |
| カスタムドメイン | `sites-verify-20261107.hayatosc.dev` |
| デプロイしたバージョン | v1 静的 / v2 Worker / v3 Worker + マイグレーション 0001 |
| round 2 の slug | `sites-cli-verify2-20261107` |
| round 2 の project_id | `appgprj_6aeea0b1614c8191870853e05852d177` |
| round 2 のデプロイ | Worker 13 版（失敗 4 件を含む）。終了後に削除 |

## 1. 依頼項目ごとの結果

| # | 項目 | 結果 | 根拠レベル |
| --- | --- | --- | --- |
| 1 | `create_site` の戻り値 | `id`（=`project_id` ではない）/ `expected_url` / `source_repository_credential` | 実測 |
| 2 | tar.gz の受理とサイズ上限 | 受理。上限は 512 MiB（536,870,912 B）ちょうど、+1 B で 400 | 実測 |
| 3 | `deploy_*` の状態遷移と URL | `pending → publishing → succeeded`、完了時に `url` が入る | 実測 |
| 4 | Worker 型で `dist/client` が配信されるか | **配信される**（`dist/client/extra.txt` が 200）。`dist/` 直下は配信されない | 実測 |
| 5 | `nodejs_compat` の有効/無効 | **有効**（`node:path` の `join`/`sep` が動作） | 実測 |
| 6 | WASM の実行時可否 | **不可**（`WebAssembly.instantiate(): Wasm code generation disallowed by embedder`） | 実測 |
| 7 | D1 マイグレーションの順序・再実行 | journal 順に適用。適用済みは再実行されない（データ保持） | 実測 |
| 8 | 環境変数の反映タイミング | 変更だけでは反映されず、**再デプロイで反映**（同一バージョン再デプロイで可） | 実測 |
| 9 | カスタムドメインの要件 | CNAME 1 本 + TXT 2 本。約 40 秒で `active` | 実測 |
| 10 | アップロード API のレスポンス形状 | 3 段階すべて確認（`status:"success"`、`download_url`） | 実測 |
| 11 | レート制限 | 30 連続 `list_sites` で 429 なし（平均 0.95 秒/回） | 実測 |
| 12 | OAuth リフレッシュ | 成功。`expires_in: 864000`、リフレッシュトークンはローテーション | 実測 |

> **round 2 で判明した訂正**: `ASSETS` バインディングは**使える**（§6.1）。round 1 の「指定手段が無い＝不可」は誤りで、正しくは「宣言不要で常に存在し、`dist/client` を配信する」。§1 の該当行と §3 の記述は §6 を優先する。

## 2. 詳細

### 2.1 `create_site` / 資格情報

```
create_site({title, slug})
→ {id: "appgprj_…", slug, status: "active", latest_version_number: 0,
   expected_url: "https://<slug>.<random>.chatgpt.site",
   source_repository_credential: {provider: "cloudflare_artifact",
     repository, branch: "main",
     remote_url: "https://git.chatgpt-team.site/<uuid>/<project_id>.git",
     token: "art_v2_…", token_expires_at: <約 10 分後>,
     auth_mode: "http_extra_header", publish_on_push_accepted: false}}
```

- `project_id` というキーは無い。**`id` を `project_id` として扱う**（`get_site` / `list_sites` も `id`）。
- `expected_url` は `create_site` のときだけ返る（`get_site` では `null`）。`url` はデプロイ完了後に入る。
- `create_source_repository_write_credential({project_id})` は同じ形の資格情報を返す。**毎回取り直す**（10 分で失効するため、保存しない）。
- `publish_on_push` は `"private"` のみ受理（ソース push で自動デプロイ）。

### 2.2 slug

- `check_slug_availability({slug})` → `{slug, available: true, status: "available"}`。
- 既存 slug は `available: false`（未使用の slug を再取得して確認）。`create_site` 側でも `CONFLICT` を返すため、事前確認は UX のため。

### 2.3 ソース同期（git）

初回は**必ずソースを push してから** `save_site_version` を呼ぶ。push していないと:

```
CONFLICT: repository_branch_not_found
The Site source branch does not exist. Push the Site source to its configured branch before saving a version.
```

手順（実測で通った形）:

```bash
git init --initial-branch main
git fetch --no-tags <remote_url> refs/heads/main
git reset --hard FETCH_HEAD        # 既存履歴に合わせる（初回から別履歴だと non-fast-forward で拒否）
git add -A && git commit -m "..."
git push <remote_url> HEAD:refs/heads/main
```

- 認証は `--config-env=http.<remote_url>.extraHeader=SITES_GIT_AUTHORIZATION` + 環境変数 `SITES_GIT_AUTHORIZATION="Authorization: Bearer <token>"`。
- `-c credential.helper= -c http.extraHeader= -c http.followRedirects=false`、`GIT_TERMINAL_PROMPT=0` を付ける。
- push 後に `git ls-remote --heads` で一致確認（プラグイン実装と同じ）。

### 2.4 `save_site_version` の `archive`

- `archive` は **オブジェクト**: `{download_url, file_id, mime_type?, file_name?}`（`additionalProperties: false`）。
- `"sediment://file_…"` の文字列を渡すと `INVALID_ARGUMENT: Expected type ['object'], got str`。
- **`commit_sha` で重複排除される**。同じ `commit_sha` で別の tar を保存すると、新しいバージョンは作られず**既存バージョンがそのまま返る**（古い内容がデプロイされる）。CLI は「ビルド内容が変わったら必ずコミットを作る」ことを保証する必要がある。
- 戻り値:

```
{id: "appgprj_…~appgver_…", project_id, version_number: 1,
 source: {commit_sha: "…"}, archive_storage: {archive_format: "tar",
 sediment_file_id, content_hash: "sha256:…", size_bytes, file_count},
 screenshot_url: "…", deployment_id: null}
```

`status` / `url` は含まれない（デプロイ結果ではない）。

### 2.5 デプロイと状態

```
deploy_private_site_version({project_id, version_id})
→ {id: "appgdep_…", status: "pending", url: null, env_set_revision: 0, …}
```

- `get_deployment_status({project_id, deployment_id})` の観測遷移: `pending`（0.7 秒）→ `publishing`（3.7 秒）→ `succeeded`（10.1 秒）。
- **終端の文字列は `succeeded`**（`deployed` ではない）。`failed` / `error` も終端として扱う。
- 完了時に `url`, `provider_deployment_id`（`site---<project_id>`）, `screenshot_asset_pointer` が入る。
- 2 回目以降のデプロイは 1 秒未満で `succeeded` になることがある（同一バージョン再デプロイの実測 637〜695 ms）。
- 環境変数の変更だけでは `url` の内容は変わらない。**再デプロイで反映**（§2.7）。

### 2.6 静的サイトと Worker サイト

**静的（v1）**: `hosting.json` は

```json
{"project_id":"appgprj_…","static":{"directory":"dist","not_found_handling":"none"},"d1":null,"r2":null}
```

- `/` 200（HTML。プラットフォームが script を注入）、`/marker.txt` 200、`/missing.txt` 404、`/index.html` 307 → `/`。
- 非公開サイトは匿名アクセスに **401（ChatGPT サインイン HTML）**。`OAI-Sites-Authorization: Bearer <siwc_bypass_bearer_token>` で 200。

**Worker（v2 / v3）**: `hosting.json` は `{"project_id":"…","d1":"DB","r2":null}`（`static` を持たない）。アーカイブは `dist/server/index.js`（単一 ESM）+ `dist/.openai/hosting.json` + `dist/.openai/drizzle/`。

| パス | 結果 | 意味 |
| --- | --- | --- |
| `/` | 200 `worker-v2` | Worker が応答 |
| `/node` | 200 `{"join":"a/b","sep":"/"}` | **`nodejs_compat` 有効** |
| `/wasm` | 500 `Wasm code generation disallowed by embedder` | 実行時 WASM コンパイル不可 |
| `/db` | 200 `{"results":[]}` | D1 バインディング `DB` 有効 |
| `/mig` | 200 `{"columns":["id","value"]}` | マイグレーション適用済み |
| `/env` | 200 `{"value":null}` → `alpha` → `beta` | env はデプロイ時に反映 |
| `/extra.txt` | 200 `client-asset-should-not-be-served` | **`dist/client/` は配信される** |
| `/client/extra.txt` | 404 | `dist/client` が配信ルート |

- つまり Worker 型でも `dist/client` 配下は静的に配信される（ASSETS 相当）。ただし `worker-esm-starter/README.md` は「単体アセットを置くな」と明記しており、これは**保証された契約ではない**。CLI の既定は「`dist/client` があれば同梱し、警告は出さない」とし、`ASSETS` バインディングの利用は**未対応**のままにする。
- `dist/` 直下のファイル（`dist/extra.txt`）は配信されない。

### 2.7 D1 マイグレーション

- v2 で `0000_init.sql`（`CREATE TABLE t (...)`) を適用 → `/mig` が `["id","value"]`。
- 行を 1 件 insert した後、v3 で `0001_add_note.sql`（`ALTER TABLE t ADD note text;`）+ journal の `entries[1]` を追加 → `/mig` が `["id","value","note"]`、既存行は保持。
- **`0000` は再実行されない**（再実行なら `table t already exists` でデプロイが失敗するはず）。適用は journal 順、適用済みは記録でスキップ。
- アーカイブには `dist/.openai/drizzle/` 配下に `*.sql` と `meta/_journal.json` を入れる。`_journal.json` が無い場合の順序は未検証。

### 2.8 環境変数とシークレット

```
update_environment_variables({project_id, set_values: [{key: "SITES_VERIFY", value: "alpha", is_secret: false}]})
→ {project_id, entries: [{key, value, is_secret, type: "envvar"}], revision: 1, updated_at}
```

- 設定直後の `/env` は `null` のまま。`deploy_private_site_version` を同じ `version_id` で再実行すると `alpha`。
- 続けて `beta`（revision 2）にすると、再デプロイ前は `alpha` のまま、再デプロイ後に `beta`。
- したがって `sites env set` は「次のデプロイで反映」と表示し、`--deploy` でのみ即時反映する設計が正しい。
- シークレットの値は API から取得できない（`get_environment` は値をマスク）。CLI は値を再表示しない。

### 2.9 カスタムドメイン

```
add_custom_domain({project_id, hostname})
→ {id: "appgdom_…", status: "pending", provider_status: "pending",
   ssl_status: "initializing",
   cname_target: "custom-domains.chatgpt.site.",
   apex_proxy_ipv4_targets: ["162.159.143.30", "172.66.3.26"],
   validation_records: [
     {record_type: "TXT", name: "_openai-site-verification.<host>", value: "openai-site-verification=vrpfsp_…"},
     {record_type: "TXT", name: "_cf-custom-hostname.<host>", value: "<uuid>"}]}
```

- 必要な DNS: CNAME `<host>` → `custom-domains.chatgpt.site`（proxied）+ 上記 TXT 2 本。
- `refresh_custom_domain_status` のポーリングで `pending/active/pending_validation` → `pending/active_redeploying/active` → `active/active/active`（約 40 秒）。
- 完了後は `https://<host>/` が既定 URL と同じ内容を返す（非公開サイトはバイパストークンが必要）。
- apex ドメインは `apex_proxy_ipv4_targets` を使う（未検証）。

### 2.10 アップロード（`/backend-api/files`）

| 段階 | リクエスト | レスポンス |
| --- | --- | --- |
| 1 | `POST /backend-api/files` `{file_name, file_size, use_case:"codex", codex_connector_id, codex_action_name, codex_model}` | 200 `{status:"success", upload_url, file_id}` |
| 2 | `PUT <upload_url>`（`x-ms-blob-type: BlockBlob`、認証ヘッダ無し） | 201 |
| 3 | `POST /backend-api/files/<file_id>/uploaded` `{}` | 200 `{status:"success", download_url, metadata, file_name, creation_time, no_auth_user_upload, mime_type:"application/x-tar", file_size_bytes}` |

- `status` は `success` か `retry`（250 ms 間隔・最大 30 秒ポーリング）。
- 上限: 536,870,912 B は 200、536,870,913 B は 400 `{"detail":{"code":"file_too_large", …}}`。
- ホストは地域依存（今回は `sdmntprjapaneast.oaiusercontent.com`）。URL はクエリ付きの署名 URL なのでログに出さない。

### 2.11 レート制限

- `sites.list_sites` を 30 回連続（逐次）→ 全て 200、合計 28.45 秒。429 は観測されず。
- 参考: 観測中に別要因で一時的に API が応答しなくなった時間帯があり、CLI は 429/5xx に対して指数バックオフ + 明示的なメッセージを出すべき（推測でリトライを増やさない）。

### 2.12 OAuth リフレッシュ

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
grant_type=refresh_token&refresh_token=<auth.json の値>&client_id=app_EMoamEEZ73f0CkXaXp7hrann
→ 200 {access_token, token_type, expires_in: 864000, scope, id_token,
       earliest_refresh_at, refresh_token}
```

- `refresh_token` は**ローテーションされる**（返ってきた値を保存しないと次回失敗する）。
- 新 `access_token` で `initialize` → 200 `{name: "plugin-runtime", version: "0.1.0"}`。
- `~/.codex/auth.json` へは一時ファイル + `rename` で書き戻し、`mode 0600`、`auth_mode` / `OPENAI_API_KEY` / `tokens.account_id` は保持、`last_refresh` を更新。
- 検証時はバックアップ（`/tmp/sites-verify/auth.backup.json`）を取ってから実行した。

### 2.13 バンドラ（Rolldown）

`/tmp/sites-fixture`（rolldown 1.3.0 / Node 24.21.0）で確認:

| 試行 | 結果 |
| --- | --- |
| `cloudflare:workers` を import、external 指定なし | 警告 `Module not found, treating it as an external dependency` のうえ**そのまま external 扱い**（esbuild はエラー） |
| `external: ["cloudflare:workers", "node:*"]` | 414 B の単一 ESM。`import { env } from "cloudflare:workers";` が先頭に残る |
| `.wasm` / `.txt` を import（プラグインなし） | `[PARSE_ERROR] Invalid Character`（バイナリを JS として解釈） |
| `load` フックで base64 文字列 → `Uint8Array` を返す | 0.36 kB の単一 ESM、追加ファイルなし |
| `platform: "neutral"` + `node:fs` | `external` に `node:*` を入れないと解決エラー。入れると import が温存 |

- esbuild との差: 未解決 import の扱い（Rolldown は警告して external 化）、`--loader` 相当がプラグイン必須、`metafile` ではなく `output` フックで出力を検査する。
- 実行時の WASM は不可（§2.6）なので、`.wasm` のインライン化は「バンドルは通るが実行できない」= **事前検査で停止**が正しい。

## 3. 実測で判明した設計への影響

1. `project_id` は `create_site` の `id`。`expected_url` は作成時のみ。→ `sites create` の出力と `hosting.json` 書き込みをこの形に合わせる。
2. ソース push が `save_site_version` の前提。→ `deploy` は必ず「コミット → push → 保存」の順。push を省略する `--no-source-sync` は既定で禁止（`--allow-dirty` 相当の明示時のみ）。
3. `commit_sha` 重複排除。→ ビルド成果物が変わったのにコミットが増えない場合、保存が無視される。CLI は「ビルド後に差分が無ければコミットを作らない」のではなく、**成果物ハッシュが変わったら空コミットでも作る**（`--allow-empty`）必要がある。
4. `archive` はアップロード結果のオブジェクト。→ `sediment://` 文字列を作る必要はない。
5. 状態は `succeeded`。→ ポーリングの終端判定を `succeeded | failed | error` に。
6. `nodejs_compat` は有効。→ `node:*` の事前検査は「警告」でよい（停止しない）。
7. WASM は実行不可。→ `.wasm` import は**事前検査で停止**（`--allow-wasm` のような逃げ道は作らない）。
8. `dist/client` は配信され、`ASSETS` バインディングの実体でもある（round 2 で訂正）。→ wrangler の `assets`（`binding: "ASSETS"`）は `dist/client` へ変換できる。別名バインディングは停止。starter の README が保証を約束していない点は注記で残す。
9. 環境変数は再デプロイで反映。→ `env set` の直後に「再デプロイが必要」を表示。
10. カスタムドメインは CNAME + TXT 2 本。→ `domains add` の出力に 3 レコードをそのまま貼れる形で出す。apex は A 2 本 + TXT 2 本。
11. 公開範囲の変更は 40–60 秒で反映。→ `access set` は `--wait` で `get_site` をポーリングし、デプロイツールの選択は `access_mode` から決める（`custom` 以外で private 系は 400）。
12. `workspace_all` は API 受理のみ。→ CLI は「組織構成に依存し実効は保証しない」と警告する。
13. マニフェストはキーのホワイトリスト方式。→ 未知キーは保存時に落ちるので、事前検査で同じキー集合を検査すればサーバ往復を減らせる。
14. マイグレーションの適用順は文字列順。→ 非ゼロ埋めのファイル名を警告し、`10_` が `1_` より先に走ることを明記する。
15. WebSocket は可、raw TCP は不可。→ `wrangler` の `[[durable_objects]]` が無い前提でも、`Upgrade` を返す Worker はそのまま通る。`cloudflare:sockets` は事前検査で警告（停止はしない）。
16. サイト内 MCP はエッジで OAuth 必須。→ `capabilities: ["mcp"]` は受理するが、`sites` から叩く手段は無い。CLI は設定のみ扱い、疎通確認はしない。
17. 失敗デプロイは `failure_message` に生のエラー。→ `deploy` は失敗時にそのまま表示し、`logs` を案内する（構文エラー等は保存後の検証段階で落ちる）。
18. アナリティクスはバケット整列必須。→ CLI 側で `start`/`end` を 1 時間境界に丸めてから送る。
19. API の揺れ（ツール数 497、`file_id` の欠落）。→ ツール数やフィールドの有無に依存しない。`file_id` は作成時の応答を保持する。

## 4. 未検証として残ったもの

round 1 の時点で残った項目は、round 2（§6）で全件を実測または「試して不可能と確定」にした。最終判定は次のとおり。

| 項目 | 最終判定 | 根拠 |
| --- | --- | --- |
| `ASSETS` バインディング | **使える**（常に注入され、実体は `dist/client`） | §6.1 |
| 公開サイト（`public`） | 実測（反映に 40–60 秒） | §6.2 |
| `workspace_all` / 許可リスト | API 受理まで実測、実効は未検証 | §6.3 |
| apex ドメイン | 受理され A 2 本 + TXT 2 本を返す | §6.4 |
| WebSocket / raw TCP | WebSocket 可 / raw TCP 不可 | §6.5 |
| KV / DO / Queues / Hyperdrive | 不可（未知キーは保存時に拒否） | §6.6 |
| `_journal.json` なしの適用順 | 適用される。順序は**文字列順** | §6.7 |
| 失敗デプロイの詳細 | `failed` + `failure_message` に生のエラー | §6.8 |
| アナリティクス / サイト内 MCP / スケジュール | 読み取りと validate は実測、MCP は OAuth ゲート、スケジュールは削除 API 不在のため未作成 | §6.9 |
| `workspace_all` の実効（他ユーザーでの確認） | 未検証 | — |
| サイト内 MCP ハンドラの挙動 | 未検証（リソース向け OAuth トークンが必要） | §6.9 |
| アナリティクスの新規イベント発生 | 未検証（検証期間の流入が少ない） | — |

## 5. 後片付け（実施済み）

| 操作 | 結果 |
| --- | --- |
| `remove_custom_domain({project_id, custom_domain_id})` | 削除時点のオブジェクトを返す。直後の `list_custom_domains` は `{items: []}` |
| DNS レコード削除（CNAME + TXT 2 本） | `cf dns records delete <id> -z hayatosc.dev -f`。削除後の一覧で該当 3 件が 0 件 |
| `delete_site({project_id})` | `{"project_id": "appgprj_…", "was_deleted": true}`（キーは `project_id`） |
| `list_sites({limit: 20})` | `{"items": [], "cursor": null}` |
| 削除後の `get_site` | `NOT_FOUND SitesConnectorError: Sites project not found`（`{"type":"project_not_found","code":404}`） |
| 削除後の既定 URL | 404（テナントの 404 ページ） |
| 削除後のカスタムドメイン | DNS 解決不可（`fetch failed`） |

- `delete_site` は**取り消し不可**。CLI は `--yes` 必須にし、`--json` 出力に `was_deleted` を含める。
- 削除すると `list_sites` から消え、`get_site` は 404 になる。「一覧に出ないが URL は生きている」状態にはならない（今回の観測範囲）。

## 6. round 2: §4 の残項目を最後まで潰す（2026-11-07 追試）

追加の使い捨てサイト `sites-cli-verify2-20261107`（`appgprj_6aeea0b1614c8191870853e05852d177`）で実施した。Worker 13 版（失敗 4 件）をデプロイし、終了後にサイトごと削除した（§6.11）。スクリプトと成果物はリポジトリ外（`/tmp/sites-verify/`）に置いた。

### 6.1 `ASSETS` バインディング — 使える（round 1 の結論は誤り）

| 試行 | 結果 |
| --- | --- |
| `dist/client` を持たない Worker で `env.ASSETS` を参照 | `{"hasAssets":true,"keys":["ASSETS"]}` |
| `env.ASSETS.fetch(new Request("https://<site>/hello.txt"))` | `{ok:true,status:200,type:"text/plain",text:"hello from client assets"}` |
| `dist/client/hello.txt` を同梱 | `/hello.txt` は 200、`/client/hello.txt` は 404 |
| `capabilities: ["assets"]` | 保存時に拒否: `Invalid dist/.openai/hosting.json: capabilities: Input should be 'mcp'` |
| `capabilities: ["mcp"]` | 受理 |

- `ASSETS` はマニフェストで宣言しなくても常に注入され、実体は `dist/client`。したがって wrangler の `assets`（`binding: "ASSETS"`）は変換できる。バインディング名を変えている場合は非対応。
- `capabilities` に入れられる値は `"mcp"` のみ。
- `ASSETS.fetch` は同一サイト内の資産を返す（外部 URL のプロキシには使えない、という前提で実装する）。

### 6.2 公開サイト（`public`）

| 操作 | 結果 |
| --- | --- |
| `update_site_access({access_mode:"public"})` | `access_mode:"public"`、`revision:2`、`available_access_modes:["custom","public"]` |
| 変更直後の匿名アクセス | 401（反映待ち） |
| 約 40–60 秒後の匿名アクセス | `/` 200、`/hello.txt` 200（本文が読める） |
| 公開中の `deploy_private_site_version` | `INVALID_ARGUMENT site_not_owner_only`: 「This site is shared, public, or could not be verified as owner-only, so no deployment was started. Use deploy_site_version instead.」 |
| 公開中の `deploy_site_version` | 成功 |
| `custom` へ戻す | `revision:3`。約 45–60 秒後に匿名 401、バイパストークン付きは 200 |
| `deploy_public_site_version` というツール | 存在しない（sites 系 39 ツールに無い） |

- 公開範囲の変更は即時ではない（40–60 秒）。CLI は変更後に `get_site` で確認し、`--wait` 指定時に待つ。
- デプロイツールは現在の `access_mode` で選ぶ。`public` / `workspace_all` で private 系を呼ぶと 400。

### 6.3 `workspace_all` と許可リスト

| 操作 | 結果 |
| --- | --- |
| `update_site_access({access_mode:"workspace_all"})` | 受理（`revision:4`）。ただし `available_access_modes` には現れない |
| `allowed_workspace_group_ids:["grp_does_not_exist"]` | `INVALID_ARGUMENT invalid_access_policy`: `Invalid workspace group id: 'grp_does_not_exist'` |
| `allowed_user_emails:["nobody@example.invalid"]` | `INVALID_ARGUMENT invalid_external_visitor_email`: `Invalid external visitor email address` |

- API は `workspace_all` を受理するが、他ユーザーでの実効確認はできていない。CLI は指定時に「組織構成に依存する」旨の警告を出す。
- グループ ID・外部メールはサーバ側で存在検証される。CLI 側は形式のみ検査する。

### 6.4 apex ドメイン

`add_custom_domain({hostname:"hayatosc.dev"})` は受理され、次を返した（DNS は作らず、直後に `remove_custom_domain`）。

- `apex_proxy_ipv4_targets: ["162.159.143.30", "172.66.3.26"]`
- `validation_records`: TXT 2 本（`_openai-site-verification.hayatosc.dev`、`_cf-custom-hostname.hayatosc.dev`）
- `cname_target: "custom-domains.chatgpt.site."` も返るが apex では使わない
- `status: "pending"`、`ssl_status: "initializing"`

CLI は apex 指定時に A 2 本 + TXT 2 本を案内する（CNAME は出さない）。

### 6.5 WebSocket / raw TCP

| 試行 | 結果 |
| --- | --- |
| 非公開サイトへの `wss://<site>/ws` | ハンドシェイク失敗（`error` イベント、詳細なし） |
| 公開サイトへの `wss://<site>/ws` | 接続成功。`send("hello")` → `echo:hello` |
| サブプロトコル要求 `["sites-verify"]` | 失敗（Worker が `Sec-WebSocket-Protocol` を返さない） |
| `cloudflare:sockets` の `connect()` → example.com:80 / 443、1.1.1.1:53、127.0.0.1:80 | いずれも `Error: Stream was cancelled.`（書き込み時） |

- WebSocket は可。認可は HTTP と同じ（非公開ならハンドシェイクが成立しない）。
- raw TCP は不可。`connect()` の import 自体は通り、例外は読み書き時に出る。

### 6.6 KV / DO / Queues / Hyperdrive

| マニフェスト | 結果 |
| --- | --- |
| `kv` / `durable_objects` / `queues` / `hyperdrive` / `unknown_key` | すべて保存時拒否: `Invalid dist/.openai/hosting.json: Extra inputs are not permitted` |
| 実行時 `Object.keys(env)` | `["ASSETS"]` のみ |
| `env.KV.get("k")` | `TypeError: Cannot read properties of undefined (reading 'get')` |
| D1 のテーブル一覧 | `__appgarden_migrations`、`_cf_KV`、`sqlite_sequence`、`t`、`v` |

- マニフェストのキーは厳格なホワイトリスト。未知キーは保存時に落ちるので、CLI の事前検査とサーバ検証を一致させられる。
- `_cf_KV` はプラットフォーム内部のテーブルで、ユーザー KV バインディングではない。

### 6.7 `_journal.json` なしのマイグレーション

| 試行 | 結果 |
| --- | --- |
| `0000_init.sql` + `0001_add_note.sql`（journal なし） | 適用され `__appgarden_migrations` に記録。再デプロイで再実行されない |
| `1_create_v.sql`（作成）+ `10_alter_v.sql`（追加） | 失敗 `no such table: v: SQLITE_ERROR`（`10_` が先に走った） |
| `0_create_v.sql` + `10_alter_v.sql` | 成功。記録順は `0000_init.sql` → `0001_add_note.sql` → `0_create_v.sql` → `10_alter_v.sql` |

- 適用順は**ファイル名の文字列順**。数値順ではない。
- `__appgarden_migrations(id, name, applied_at)` に記録し、適用済みは名前でスキップする。
- journal は必須ではないが、drizzle-kit 既定のゼロ埋め命名（`0000_`）なら順序問題は起きない。CLI は非ゼロ埋めを警告する。

### 6.8 失敗デプロイの形

| 壊し方 | 終端 `status` | `failure_message` |
| --- | --- | --- |
| static + d1 | `failed` | `Static-only site bundles cannot use runtime resource bindings, capabilities, or database migrations. Use a Worker build without static configuration for these features.` |
| 構文エラー | `failed` | `Uncaught SyntaxError: Unexpected end of input\n  at dist/server/index.js:3\n` |
| 存在しない import | `failed` | `Uncaught Error: No such module "dist/server/missing-module.js".\n  imported from "dist/server/index.js"` |
| マイグレーション SQL エラー | `failed` | `no such table: v: SQLITE_ERROR` |

- 失敗時も `url` は `null`、`type` は `"publish"`、`env_set_revision` は 0。デプロイオブジェクトのキーは `id, project_id, title, version_id, type, status, url, has_mcp, screenshot_asset_pointer, provider_deployment_id, failure_message, env_set_revision, updated_at`。
- `failure_message` に生のエラーが入るので、CLI はそのまま表示してよい。
- 構文エラーと import 解決は保存後の検証段階で落ちる（保存自体は成功する）。
- `get_site_worker_logs` のイベントは `$metadata.trigger`、`source.message`、`source.exception.stack` を持つ。

### 6.9 アナリティクス / サイト内 MCP / スケジュール

**(a) アナリティクス**

- `start_time_ms` / `end_time_ms` はバケット境界に整列が必要（UTC-08:00 基準）。整列しないと `INVALID_ARGUMENT invalid_analytics_overview_query`。
- `view:"classic"` は `request_traffic{total_requests, unique_visitors, points[{timestamp_ms, requests, unique_visitors, requests_by_type}], top_paths[{path, requests, unique_visitors}]}` を返す。`requests_by_type` は `page_load` / `api_call` / `unknown`。
- `view:"list"` は `overall` / `timeseries` のみで `request_traffic` は `null`、`page_views` は 0 のプレースホルダ。
- `list_site_analytics_events` は `{project_id, event_names: []}`。

**(b) サイト内 MCP**

- `capabilities:["mcp"]` で保存・デプロイでき、`has_mcp: true`、`get_site(include_mcp_connection:true)` が `{mcp_url, oauth_resource, plugin_id}` を返す。
- しかし `POST /mcp` はエッジの OAuth ゲートで 401:
  `WWW-Authenticate: Bearer resource_metadata="https://<site>/.well-known/oauth-protected-resource/mcp", scope="openid resource.invoke email"`
- `/.well-known/oauth-protected-resource/mcp` は `{authorization_servers:["https://auth.openai.com"], bearer_methods_supported:["header"], resource, scopes_supported}` を返す。
- バイパストークン（`OAI-Sites-Authorization`）でも Codex のアクセストークンでも 401。ハンドラの挙動は未検証。

**(c) スケジュール**

- `validate_suggested_schedule` は提案をそのまま返す: `{project_id, title, current_live_url, schedule_suggestion{title, prompt, schedule}}`。
- `create_schedule` は `get_site.schedule_request_id`（`YYYY-MM-DD:...` 形式）を要求し、`automations` が `null` だと作成しない。
- 削除・一覧のツールが無いため、指示どおり作成していない（作ったら消せないため）。

### 6.10 round 2 で分かった API の揺れ

- `tools/list` の総数は 470 → 497 に増えていた（sites 系は 39 のまま）。ツール一覧は固定ではない。
- ファイル確定 API（`POST /files/<id>/uploaded`）の応答から `file_id` が消えた。`file_id` は作成時の応答を使う（round 1 の実装はここに依存していた）。
- `get_site` は `include_mcp_connection` 無しでも `siwc_bypass_bearer_token` / `schedule_request_id` / `automations` / `access_policy` / `available_access_modes` を返す。
- MCP の応答が SSE ではなく素の JSON で返ることがあった。クライアントは両方を受ける必要がある。

### 6.11 後片付け（round 2）

| 操作 | 結果 |
| --- | --- |
| `add_custom_domain(hayatosc.dev)` → 即 `remove_custom_domain` | `list_custom_domains` は `[]`。DNS は変更していない |
| `delete_site({project_id})` | `{"project_id": "appgprj_6aeea0b1614c8191870853e05852d177", "was_deleted": true}` |
| `list_sites({limit: 20})` | `{"items": [], "cursor": null}` |
| 削除後の既定 URL | 401（round 1 は 404。テナントの認可ページが先に返る） |
| `hayatosc.dev` の `sites-cli-verify` 系レコード | 0 件 |

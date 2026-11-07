# Codex の挙動を Codex の外で再現するためのまとめ

ChatGPT Sites のツール呼び出しと、Codex のモデル応答を、Codex 本体を使わずに再現する方法。2026-11-06 に本人のPC（Codex 0.166.0、ChatGPT サブスクリプション認証）で実測検証した結果を含む。前提となる内部構造は `chatgpt-sites-internal-tools-ja.md`（付録A/B）を参照。

## 結論: 再現経路は3つ

| 経路 | 対象 | 検証状態 |
| --- | --- | --- |
| A. `ps/mcp` 直結 | Sites など全コネクタのツール呼び出し | **実測済み**（initialize / tools/list / tools/call すべて成功） |
| B. `codex app-server` 経由 | 同上（Codex を部品として使う） | 公開実装で実証済み（今回は未実測） |
| C. Responses 直叩き | モデルの応答生成 | ソース確認＋既存実装（pi / kodama）で動作実績あり |

どれも「ChatGPT にログイン済みの OAuth トークン」が起点になる。バックエンド自体は OpenAI のものなので、再現できるのはクライアント側の挙動まで。公開や実行の実体は向こう側にある。

## 前提: トークンの入手と扱い

- Codex にログイン済みなら `~/.codex/auth.json` に `{auth_mode: "chatgpt", tokens: {access_token, refresh_token, id_token, account_id}, last_refresh}` がある。これを読むのが一番簡単
- アクセストークンは期限切れになる。切れたら `POST https://auth.openai.com/oauth/token` にフォーム形式（`grant_type=refresh_token`、`refresh_token`、`client_id`）で更新する。Codex 本体も同じ更新を裏でやっている
- 自前でログインから実装する場合は OAuth 認可コードフロー（ブラウザで `https://auth.openai.com/oauth/authorize` を開き、ローカルホストのコールバックで受ける）。デバイスコード用の `/api/accounts/deviceauth/usercode`、`/api/accounts/deviceauth/token` もある
- 注意: このトークンは資格情報そのもの。スクリプトやログに平文で残さない。利用量は Codex 本体と**同じサブスクリプション枠**を消費する。そしてこれは公式 API ではなく ChatGPT バックエンドの内部経路なので、仕様は予告なく変わりうる

## 経路A: `ps/mcp` 直結（推奨・実測済み）

Codex 本体は、コネクタ用にリモート MCP サーバーへ MCP クライアントとして接続している。その接続先に直接つなげば、Codex を介さずに同じツールが使える。

### 接続先とヘッダー

```text
POST https://chatgpt.com/backend-api/ps/mcp
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream
X-OpenAI-Product-Sku: codex
originator: codex_cli_rs
User-Agent: codex_cli_rs/0.166.0 (Linux; x86_64) rust
```

- `X-OpenAI-Product-Sku` と `originator` は Codex のソース（`codex-mcp/src/mcp/mod.rs`）で固定されていた値
- **User-Agent が重要**: Python 標準（urllib のデフォルト UA）のままだと Cloudflare に **403** で弾かれることを実測で確認した。Codex 形式の UA を付けると通る
- 接続は実質ステートレスだった（実測では `Mcp-Session-Id` は返らず、セッションなしで続行できた）

### 手順（MCP の通常作法どおり）

1. `initialize`（`protocolVersion: "2025-03-26"`、`clientInfo` を送る）→ 応答の `serverInfo` は `{name: "plugin-runtime", version: "0.1.0"}`
2. `notifications/initialized` を送る
3. `tools/list` → 実測で **全470ツール**（キャッシュの462より新しい）、うち `sites.*` が **39件**
4. `tools/call` に `{name: "sites.list_sites", arguments: {limit: 5}}` の形で実行 → 実測成功。応答は MCP 形式で、実データは `result.structuredContent`（`{items, cursor}`）に入る

### 動く最小実装（実測で使ったもの、そのまま）

```python
import json, urllib.request, urllib.error

auth = json.load(open('/home/hayato/.codex/auth.json'))
token = auth['tokens']['access_token']
URL = 'https://chatgpt.com/backend-api/ps/mcp'
HEADERS = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'X-OpenAI-Product-Sku': 'codex',
    'originator': 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.166.0 (Linux; x86_64) rust',
}

def post(payload):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
                                 headers=HEADERS, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.read().decode('utf-8', 'replace')

def parse(body):  # SSE 形式と素の JSON の両対応
    out = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith('data:'):
            try: out.append(json.loads(line[5:]))
            except Exception: pass
        elif line.startswith('{'):
            try: out.append(json.loads(line))
            except Exception: pass
    return out

post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "repro", "version": "0.1.0"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"})
_, body = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
tools = []
for m in parse(body):
    tools += (m.get('result') or {}).get('tools') or []
print(len(tools), [t['name'] for t in tools if t['name'].startswith('sites.')])

_, body = post({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
    "name": "sites.list_sites", "arguments": {"limit": 5}}})
print(parse(body))
```

書き込み系（作成・保存・デプロイ）も同じ `tools/call` で同じ形。引数は付録A補足の表（39ツールの引数一覧）のとおり。環境変数 `CODEX_CONNECTORS_TOKEN` にトークンを入れる運用も Codex 本体側に用意されている（`bearer_token_env_var` として参照される）。

## 経路B: `codex app-server` 経由（Codex を部品にする）

Codex 本体を子プロセスとして使う方式。公開ブリッジ `make-chatgpt-site` がこの形で、MCP サーバーとして他エージェントから Sites を使えるようにしている。

```text
起動: codex app-server --stdio   （改行区切り JSON-RPC を stdio で）

1. initialize        {clientInfo, capabilities: {experimentalApi: true}}
2. thread/start      {cwd, ephemeral: true, sandbox: "read-only", approvalPolicy: "never"}
3. app/list          {threadId, limit: 100}        → 名前 "sites" のアプリを確認
4. mcpServerStatus/list {threadId, detail: "toolsAndAuthOnly", limit: 100}
                                                   → codex_apps のツール定義と authStatus が返る
5. mcpServer/tool/call {server: "codex_apps", threadId, tool: "sites.<操作>", arguments: {...}}
```

向いている場面: トークン管理やツール定義の取得・キャッシュ、承認フローなどを Codex 本体に肩代わりさせたいとき。直結（経路A）より一段重い代わりに、認証まわりの面倒が消える。ブリッジ側では、公開・公開範囲変更・環境変数・ドメイン付け外しのような結果の重い操作に `confirm=true` を必須化する、という安全弁を足すのが定石だった。

## 経路C: モデル応答の再現

モデル自体を外から叩くなら、Codex と同じ宛先に同じ形で送る。

```text
POST https://chatgpt.com/backend-api/codex/responses
Authorization: Bearer <access_token>
chatgpt-account-id: <account_id（id_token の https://api.openai.com/auth クレームからも取れる）>
Content-Type: application/json

{
  "model": "gpt-6.1-sol",
  "stream": true,
  "input": [ ...会話・指示・ツール結果... ],
  "tools": [ ...ツール定義... ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {"effort": "high"},
  "store": false,
  "include": ["reasoning.encrypted_content"]
}
```

- 応答は SSE（`response.output_text.delta` などのイベント列）。フィールド構成は Codex のソース `codex-api/src/common.rs` の `ResponsesApiRequest` が正本
- API キー運用なら宛先は `https://api.openai.com/v1/responses` に替わる（公式 API なので、長期運用はこっちが無難）
- この経路は pi（`chatgpt.com/backend-api` を既定基底にする Codex プロバイダ）や kodama の設計で既に使われている形なので、新規性はない。今回の実測は経路Aに絞ったため、経路Cは未実測として区別しておく

## Sites 公開パイプライン全体の再現手順（経路A＋ローカル作業）

「サイトを作って公開する」一連の流れは、ツール呼び出し（経路A）とローカル作業（git / tar）の組み合わせで再現できる。ローカル作業はプラグインのスクリプトをコピーしても、自前で書いてもいい（中身は判明している）。

```text
1. tools/call sites.create_site {title, slug}
   → 応答に id（project_id）と source_repository_credential が含まれる

2. ローカルに雛形を用意して実装する
   - .openai/hosting.json に project_id を書く
   - サーバー挙動が要るなら Vinext 雛形、単純なページなら静的 dist でも可

3. tools/call sites.create_source_repository_write_credential {project_id}
   → {remote_url, branch, token, auth_mode, token_expires_at}

4. git push（トークンは環境変数経由の extraHeader で渡す。config に残さない）
   git -c credential.helper= -c http.followRedirects=false \
       --config-env=http.<remote_url>.extraHeader=SITES_GIT_AUTHORIZATION \
       push <remote_url> HEAD:refs/heads/<branch>
   ※ 環境変数 SITES_GIT_AUTHORIZATION に "Authorization: Bearer <token>" を入れておく

5. ビルドして site.tar.gz を作る（トップは dist/ のみ）
   - dist/server/index.js（Worker 本体）
   - dist/.openai/hosting.json
   - dist/.openai/drizzle/（D1 マイグレーション）

6. tools/call sites.save_site_version {project_id, commit_sha, archive}
   → {version_number, deployment_id, ...}

7. tools/call sites.deploy_site_version {project_id, version_id}（公開）
   または sites.deploy_private_site_version（非公開）

8. tools/call sites.get_deployment_status {project_id, deployment_id}
   を succeeded / failed までポーリングし、最後に実 URL を取得して中身を確認する
```

## 再現できないもの・再現しないもの

- **ログインの対話部分**: 初回ログインはブラウザでの対話が前提。自動化するならログイン済みトークンの再利用が現実解
- **バックエンドの実体**: サイト登録、ソースリポジトリ、デプロイパイプライン、ホスティング（Workers/D1/R2）は OpenAI 側のもので、手元に複製は作れない。再現できるのは「同じ操作を外から発行する」ところまで
- **別枠の利用量**: どの経路でも消費は本人の ChatGPT/Codex 枠から出る。経路を変えても無料にはならない

## ハマりどころ（実測・ソースから）

- **UA で 403**: 前述のとおり、ライブラリ既定の User-Agent だと Cloudflare に弾かれることがある。Codex 形式の UA を付ける
- **ツール一覧はキャッシュより実物**: ローカルキャッシュは462件だったが、実測の `tools/list` は470件。サーバー側で増減するので、再現コードは一覧を固定せず毎回取りに行くのが正しい。同義ツールの併存（`get_database_overview` と `read_database_overview`）もある
- **`archive` の渡し方**: `save_site_version` のスキーマ上 `archive` は任意（`project_id` と `commit_sha` だけが必須）。経路によってはソースの push だけで保存できる場合がある。ブリッジ実装は `archive` を意図的に外して commit ベースで保存していた
- **トークンの混同**: Sites のソースリポジトリ用トークン（手順4）と、ChatGPT の OAuth トークンは別物。前者は短命で、期限切れなら同じサイト向けに再発行してからやり直す
- **状態の成功＝配信の成功ではない**: デプロイ状態が `succeeded` でも、Worker として成立していない成果物だと配信側は 404 になりうる。最後は実 URL の中身で確認する

## 出典

- 実測: 自宅PCから `https://chatgpt.com/backend-api/ps/mcp` への直結テスト（2026-11-06 19:29–19:31 JST）。initialize 200、`tools/list` 200（470件／Sites 39件）、`tools/call sites.list_sites` 200（structuredContent に items/cursor）
- Codex ソース v0.166.0: `codex-mcp/src/mcp/mod.rs`（接続先 URL の組み立て、ヘッダー、認証方式）、`codex-api/src/common.rs`（Responses のリクエスト構造）
- 公開ブリッジ: GitHub `jacoblincool/make-chatgpt-site`（app-server 経由の手順）
- プラグイン v1.1.3 実物: `scripts/site-workflow.mjs`、`scripts/package-site.mjs`（git 経路とパッケージ形式）

## ファイルアップロードの仕様（archive の実体）— ソース＋実測で確定

`sites.save_site_version` の `archive` は、ツールの `_meta` に `"openai/fileParams": ["archive"]` と宣言されたファイル入力。Codex の中では、モデルがローカルパス文字列を渡すと、実行時に本体（`core/src/mcp_openai_file.rs`）がそのファイルをアップロードし、引数をアップロード済みペイロードに書き換えてから `tools/call` する。外から再現する場合も、同じ3段階を自分でやればよい。

### 手順

```text
1. POST https://chatgpt.com/backend-api/files
   Authorization: Bearer <access_token>
   Content-Type: application/json
   {
     "file_name": "site.tar.gz",
     "file_size": <バイト数>,
     "use_case": "codex",
     "codex_connector_id": "connector_20205bf7d4e99a89d7154bb849718324",
     "codex_action_name": "save_site_version",
     "codex_model": "<使用モデル>"
   }
   → 200 {status, file_id: "file_...", upload_url: "https://sdmntpr*.oaiusercontent.com/..."}

2. PUT <upload_url>   （Azure Blob への直接アップロード。署名付きURLなので認可ヘッダーは付けない）
   x-ms-blob-type: BlockBlob
   x-ms-client-request-id: <UUID>
   Content-Length: <バイト数>
   body: ファイルの中身そのまま
   → 201。Codex 本体は 502/503/504 と接続系エラーに最大5回までリトライ（全体5分まで）

3. POST https://chatgpt.com/backend-api/files/<file_id>/uploaded
   body: {}
   → {status: "success" | "retry" | ..., download_url, file_name, mime_type, file_size_bytes}
   "retry" の間はポーリング（Codex 本体は 250ms 間隔・最大30秒）

4. 得られた {download_url, file_id, mime_type, file_name} を
   sites.save_site_version の archive 引数として渡す
```

### 仕様の要点

- 上限は **512 MiB**（`OPENAI_FILE_UPLOAD_LIMIT_BYTES`）
- アップロード先ホストはリージョンで変わる（実測では `sdmntprjapaneast.oaiusercontent.com`、Japan East）。前回の通信実測で出てきた `*.oaiusercontent.com` への接続はこれ
- ファイルの URI 表記は `sediment://<file_id>`
- `save_site_version` 側の説明では、archive は「commit_sha のソースから作ったビルド成果物（ソースツリーそのものではない）で、`.openai/hosting.json` と Worker 入口または静的 index.html を含むこと。**ローカルでパッケージできる場合は常に付ける**。付けないのはパッケージが完了できない場合だけ」— つまり archive 付きが本道で、無しは例外扱い
- ツール側の設定は `"openai/fileUploadConfig": {"store_in_library": false}`（ライブラリに残さない指定）

### 実測記録（2026-11-06 20:03 JST）

38 バイトのテキストファイル `spec-test.txt` で全手順を実測し、create 200 → blob PUT 201 → finalize `status: "success"`（download_url・mime_type・file_size_bytes 付き）まで確認した。このテストで本人のアカウントに `file_00000000cd74820...` のファイルレコードが1件できている。

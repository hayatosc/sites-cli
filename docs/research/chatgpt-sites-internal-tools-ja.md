# ChatGPT Sites の内部動作とツール構成 — 調査まとめ

調査日: 2026-11-06
調べ方: 自宅PC（WSL）を操作し、本人の Codex CLI 0.166.0 に入っている Sites プラグイン実物（`~/.codex/plugins/cache/openai-curated-remote/sites/1.1.3/`、1.9 MB）を読み解いた。あわせて OpenAI 公式ドキュメント（Help Center / ChatGPT Learn）と、公開されている解析（GitHub 上の Sites スキル複製、Codex アプリの変更履歴リポジトリ等）で裏取りした。
凡例: **確定** = プラグイン実物または公式文書で確認できたこと。**推定・未確認** は末尾に分けて書いた。

## 結論を先に

ChatGPT Sites は「チャットが HTML を返す機能」ではなく、**Codex エージェントに3点セットを持たせたもの**だった。

1. **プラグイン（ローカル層）** — 手順書であるスキル文書、機械作業をするスクリプト群、雛形プロジェクト。これが Codex の手元で動く
2. **ネイティブツール（接続層）** — サイトの作成・保存・デプロイ・状態確認などを行う専用ツール群。Codex のエージェント環境の中だけに存在するコネクタ（MCP）経由で提供される
3. **ホスティング基盤（実行層）** — Cloudflare Workers / D1 / R2 の上で OpenAI が運用する実行環境。認証や公開範囲の制御もここが担う

サイト作成がチャットの利用枠ではなく **Codex の利用枠を消費する**のは、この構造そのものが理由（公式 Help Center 明記）。

## 1. ローカル層: Sites プラグインの中身（確定・実物確認）

本人の PC の Codex には、リモートカタログ `openai-curated-remote` から **Sites プラグイン v1.1.3** が入っていた。構成は次の通り。

| 要素 | 実体 |
| --- | --- |
| プラグイン定義 | `.codex-plugin/plugin.json`（表示名 Sites、機能は「Build, save, deploy, and inspect websites」） |
| コネクタ紐付け | `.app.json` がアプリ ID `connector_20205bf7d4e99a89d7154bb849718324` を必須（`required: true`）として宣言 |
| スキル文書 | `skills/sites/SKILL.md`（本体ワークフロー）＋ `skills/sites-remix/SKILL.md`（既存サイトのリミックス用）＋ 機能別リファレンス 9 本 |
| 補助スクリプト | `scripts/` に Node スクリプト 12 本（次節） |
| 雛形 | `skills/sites/templates/` に `vinext-starter` と `worker-esm-starter` の2種 |

つまり「ツール構成」の正体は、**モデルへの手順書（スキル）＋ 決まった機械作業のスクリプト化 ＋ 専用ツールへの接続宣言**という、通常の Codex プラグインの形をしている。Sites 固有の賢さはモデルの中ではなく、このプラグインと接続先ツールに実装されている。

### 補助スクリプト（`scripts/*.mjs`）の役割

- `project-setup.mjs` — 雛形をコピーし、チェックアウト側の状態を用意する
- `set-project-id.mjs` — 作成されたサイトの ID（と静的サイトの場合は公開ディレクトリ）を `.openai/hosting.json` に書き込む
- `install-dependencies.mjs` — 依存関係のインストール（パッケージマネージャ選択や中断復旧込み）
- `build-site.mjs` — ビルド実行
- `package-site.mjs` — 成果物をアーカイブ（tar.gz）に固める
- `site-workflow.mjs` — ソース同期とパッケージングの司令塔（第3節）

## 2. 接続層: ネイティブツール群（確定）

サイトの登録・公開まわりはモデルの手元では完結せず、**`codex_apps` という MCP サーバー上の Sites コネクタツール**を呼ぶ。プラグインのスキル文書では短縮名、外部からは `sites_` 接頭辞付きの名前で見える（コード実行環境では `mcp__codex_apps__sites_*` の形）。

| ツール（短縮名） | 役割 |
| --- | --- |
| `create_site` | 新規サイトを作成（初期状態は非公開・未公開）。ID とソース書き込み用クレデンシャルを返す。アプリ連携が必要なら `enable_plugins: true` を付ける |
| `get_site` | サイトの状態・公開範囲・連携情報の取得。`include_mcp_connection: true` でサイト由来プラグインの ID も取れる |
| `search_sites` | URL やスラッグから既存サイトを引く（リミックス時など） |
| `remix_site` | 公開済みサイトを元に新しい未公開サイトを作る |
| `create_source_repository_write_credential` | サイトのソースリポジトリへの短期書き込みクレデンシャルを発行 |
| `save_site_version` | アーカイブ＋コミット SHA から「デプロイ可能な版」を保存する |
| `deploy_site_version` / `deploy_private_site_version` | 保存した版を公開する（公開範囲で使い分け） |
| `save_version_and_deploy_private` | オーナーのみの非公開サイト向けに、保存と公開を1回でやる近道 |
| `get_deployment_status` | デプロイの進行確認（pending / building / publishing の間だけポーリング） |
| `list_plugin_eligibility` | そのサイトで使える接続アプリ（プラグイン）の適格性を確認する |
| `get_environment_variables` / `update_environment_variables` | サイトの環境変数・シークレットの設定（値はチャットやソースに書かせない決まり） |
| `create_schedule` / `offer_site_schedule` | サイトに紐付く定期実行（Automations）の作成・提案 |

このツール群は **公開 API としては提供されていない**。公開プロジェクト `make-chatgpt-site` も、他エージェントから使うにはローカルの Codex の `app-server` を経由して `codex_apps` に橋渡しする作りになっており、「MCP クライアント → 橋渡し → codex app-server → codex_apps → ChatGPT Sites」という経路を明記している。つまり Sites の操作面は **Codex のセッション内蔵が前提のクローズドなツール面**である。

## 3. 作成から公開までの流れ（確定・スキル文書のワークフローそのまま）

スキル文書が Codex に課す手順は6段階で、順序まで固定されている。

1. **選択して開く** — 既存サイトなら `get_site` ＋書き込みクレデンシャル取得→ソース取得ヘルパーでチェックアウトを開く。新規なら作業ディレクトリに空のプロジェクトを作る
2. **準備と起動** — `project-setup.mjs` で雛形を展開。並行して `create_site` で登録し、返った ID を即座に `set-project-id.mjs` で `.openai/hosting.json` に保存。依存インストールも先に走らせる
3. **実装** — アプリ本体を書く。プレビューは環境で分岐（管理 Linux コンテナでは内部 QA 用プレビュー、それ以外はローカルプレビュー）
4. **検証とパッケージ** — `site-workflow.mjs` にクレデンシャルを **stdin 経由だけ**で渡す（引数・ファイル・出力には絶対に出さない）。ヘルパーが Git の準備→チェック／ビルドのコマンド列実行→コミット＆プッシュ→`package-site.mjs` でアーカイブ化までを担う
5. **公開** — 公開範囲に応じて保存／デプロイツールを呼ぶ。「版の保存」と「デプロイ」は分離されていて、デプロイ URL はすべて本番 URL（ステージングはない）
6. **完了確認** — `get_deployment_status` で終端状態まで確認し、デプロイ URL を返す

補足の設計判断として面白い点:

- 各サイトには **OpenAI 側にソースリポジトリ**があり、Codex は短期クレデンシャルで Git プッシュする。クレデンシャルの受け渡しは stdin 限定、期限切れなら再発行、という運用まで手順書に書かれている。`auth_mode` が `work_proxy` の場合はトークン自体が含まれず、Work 側が認証を肩代わりする
- 単純なページはビルドなし HTML/JS（`dist/` をそのまま公開）でもよく、サーバー動作が要る場合だけ Vinext 雛形に寄せる、という使い分けが手順書の既定になっている

## 4. 生成されるプロジェクトの実物（確定・雛形を確認）

既定の雛形 `vinext-starter` は、Cloudflare Workers 向けに作られた Next.js 互換構成だった。

- **フレームワーク**: `vinext` 1.0.0-beta.5（Vite ベースの Next.js App Router 再実装）＋ Next.js 16.3.4 / React 19.2.6。ビルドは `sites()` Vite プラグイン（`@openai/sites-vite-plugin` 0.2.0 を雛形内に同梱）＋ `@cloudflare/vite-plugin` で Worker 形式（ES モジュール）に出力する
- **Worker 入口**: `worker/index.ts` が vinext の fetch ハンドラを包み、リクエスト単位で `CONNECTORS` バインディングを取り込む
- **ローカル実行**: `wrangler dev` で `dist/server/wrangler.json` を使い、ローカル D1 等に永続化する（`package.json` の start スクリプトで確認）
- **DB**: Drizzle ORM 0.45.2 ＋ D1。スキーマは `db/schema.ts`、マイグレーションは `npm run db:generate` で生成し、**デプロイ時に OpenAI 側がホスト側 DB へ適用してから Worker を上げる**（適用済みマイグレーションは不変、という規約まで手順書にある）
- **設定ファイル**: `.openai/hosting.json` が要で、フィールドは `project_id` / `static`（静的公開時のディレクトリ）/ `d1` / `r2`（バインディング名、未使用は null）/ `capabilities` / `plugins` / `connectors`。シークレットはここに書くな、が明記されている

静的のみのサイト向けに、素の Worker ESM 雛形（`worker-esm-starter`）も同梱されている。

## 5. 実行層: ホスト側ランタイム（確定）

- 実行基盤は **Cloudflare Workers**（OpenAI 公式技術文書・複数解析で一致）。サーバーコードは isolate あたりメモリ 128 MB、外向き接続は HTTP / HTTPS / WebSocket のみで、生 TCP は不可
- **ストレージ**: D1（リレーショナル DB、1サイト 10 GB まで）と R2（ファイル保存、固定上限なし）。雛形では D1 のバインディング名 `DB`、R2 は `BUCKET` が標準
- **認証はプラットフォーム側（Dispatch）が担当**。サインイン済み訪問者の情報はリクエストヘッダーで Worker に渡される:
  - `oai-authenticated-user-id`（サイト内でのみ安定な ID、サイトごとに異なる）
  - `oai-authenticated-user-email`
  - `oai-authenticated-user-full-name`（任意、パーセントエンコード UTF-8）
- サインイン導線のパス `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback` はプラットフォーム予約で、サイト側で実装してはいけない。雛形の `app/chatgpt-auth.ts` はヘッダーを読むだけの薄いヘルパー
- 非公開サイトへプログラムからアクセスするためのバイパストークン（`siwc_bypass_bearer_token`）があり、`OAI-Sites-Authorization: Bearer ...` ヘッダーで使う。訪問者 identity とは別物、と区別されている
- デプロイ先の Cloudflare アカウントは利用者のものではなく OpenAI 運用。利用者は D1 / R2 の実アカウントや Worker 名を直接触れない

## 6. サイトから外部アプリを呼ぶ仕組み（確定）

Sites の目玉の一つ「訪問者の接続済みアプリを使うサイト」は、次の形で実現されている。

- サイトのサーバーコードは、リクエストスコープで渡される `ctx.props.CONNECTORS` を入口で捕まえ、`connectorsForRequest().invoke(connectorId, actionName, args)` で **訪問者本人の接続と同意**を使ってアプリ（Gmail や GitHub 等のコネクタ）を呼ぶ
- どのアプリのどの操作まで許すかは `.openai/hosting.json` の `plugins` / `connectors` 宣言で固定する。`action_selection_mode` は `read_only`（既定）か `all`（読み書き一括）の二択で、操作単位の細かい指定は未対応
- 使えるアプリは事前に `list_plugin_eligibility` で適格性を確認したものだけ。ID や操作名の推測呼び出しは手順書で禁止されている
- 書き込みは「サインイン済み訪問者の明示的なクリック／送信」が必須で、描画中・GET・プリフェッチ・ビルド中の変更は禁止。結果の成否は HTTP 200 ではなく本体の `status: "success"` で判定する、といった実務的な事故防止が手順書に細かく書かれている
- **ローカルプレビューの再現方法**が特に凝っている: プレビュー時は補助 Worker（`sites-connector-preview`）が `CONNECTORS` サービスバインディングとして差し込まれ、プレビューセッションのヘルパーが **改行区切り JSON-RPC 2.0 を stdin/stdout で中継**して、エージェント側のネイティブツール呼び出し（読み取りのみ）に橋渡しする。許可リストは `.sites-runtime/connector-grants.json` に置かれ、本番ビルドにはプレビュー用アダプタを含めない

## 7. サイト自身がツール提供者になる（確定）

逆向きの経路も用意されている。サイトが他エージェント向けにツールを公開する仕組み。

- `.openai/hosting.json` の `capabilities` に `"mcp"` を入れ、サイトに無状態の JSON-RPC エンドポイント `POST /mcp` を実装する。プラグイン v1.1.3 の手順書では MCP の版として **2026-07-28** を優先指定し、`server/discover` / `tools/list` / `tools/call` の3メソッド実装を求めている
- 認証（呼び出し元がそのサイトを見られるか）は Sites 側が先に済ませ、呼び出し元の identity ヘッダーを付けてサイトに転送する
- オーナーが `"mcp"` 付きで公開すると、**Sites がその人専用の App とプラグインを自動生成**する。再公開のたびにサイトの `/mcp` から最新のツール一覧を取り直してプラグイン側を更新する。利用者は `codex mcp add` のような個別設定なしに ChatGPT / Codex からそのサイトのツールを使える

もう一つの任意機能として、ページ内の操作をブラウザエージェントに開放する **WebMCP** 対応（`document.modelContext.registerTool(...)` でクライアント側登録）も手順書に含まれている。ページが開いている間だけ有効なツールになる。

## 8. 定期更新（確定）

- サイトには Automations（定期実行タスク）を紐付けでき、ツールは `create_schedule` / `offer_site_schedule`（チャット上でボタン提示→承諾で作成）
- 無人更新の経路は「サイトの MCP サーバー」か「バイパストークン付きの更新エンドポイント」が前提で、ブラウザ側の仕組み（WebMCP やローカルプレビュー）は無人実行には使えない、と切り分けられている

## 9. 利用枠と課金の切り分け（確定・公式）

- **作成・編集**: プランの Codex 利用枠を消費
- **ホスティング**: 実行・トラフィック・保存は別枠。2026-12-31 までは無料で、2027-01-01 から計量開始（プラン内蔵の月次許容量を超えた分だけ超過課金）という予定が ChatGPT Learn に掲載されている。目安レート: DB ありサイトは月 25 credits、10万リクエスト 16 credits、DB 保存 1 GiB/月 150 credits、ファイル保存 1 GiB/月 3.75 credits、カスタムドメイン月 25 credits
- 対象プラン: Plus / Pro / Business / Enterprise / Edu。Free / Go は対象外

## 10. 確定と推定の切り分け

**確定（実物・公式で確認）**

- 3層構造（プラグイン／`codex_apps` 上のコネクタツール／Cloudflare 基盤）と、本人の PC に入っているプラグイン v1.1.3 の中身一式
- ツール名とワークフローの順序、`.openai/hosting.json` の契約、identity ヘッダーの名前、コネクタ呼び出しとローカルプレビュー中継の方式、サイト側 MCP サーバーの仕様

**推定・未確認**

- OpenAI 側バックエンド（サイト登録、ソースリポジトリの実体、デプロイパイプライン内部）の実装は非公開。上の記述はクライアント側に出てくる契約からの読み解き
- ツールの完全なパラメータスキーマはプラグイン文書に載っておらず、セッション内でのみ提示されるものと思われる
- ビルドに使うモデルは固定ではない（公式ショーケースでは Codex + GPT-5.6 製の例が明記されている）。「Sites = 特定モデル」という理解は正確ではない
- 本人のアカウントで実際にサイトを作成・公開する検証は行っていない（作成・公開は Codex 利用枠の消費と外部への公開を伴うため、調査範囲を読み取りに留めた）
- 実地プローブとして、自宅PCの Codex CLI（`codex exec`、読み取り専用サンドボックス）から Sites ツールの列挙を試みたが、ツール呼び出しが「user cancelled MCP tool call」で繰り返しキャンセルされ、制限時間内に列挙結果は得られなかった。非対話の CLI 実行では Sites ツールの呼び出しがそのままでは通らない、という挙動までは確認できた（公開情報でも、サイトの作成・公開・管理は ChatGPT ウェブ版／デスクトップアプリ側の操作とされ、CLI はローカルファイル編集担当と位置付けられている）

## 参考にしたもの

- 自宅PC上の実物: `~/.codex/plugins/cache/openai-curated-remote/sites/1.1.3/`（`skills/sites/SKILL.md`、リファレンス群、`scripts/`、雛形2種）
- OpenAI 公式: Help Center「Creating and using ChatGPT Sites」、ChatGPT Learn「Sites」
- 公開解析: GitHub `agenticseo/skills` の chatgpt-sites スキル複製、`jacoblincool/make-chatgpt-site`（Codex app-server 経由の橋渡し）、`wangnov/codex-app-changelog`（デスクトップ版への Sites バンドルの経緯）、Stacktree / Bravos の解説記事

---

# 付録A: エンドポイントと呼び出しの詳細

「具体的にどこを、どんな形で叩いているか」を経路ごとに分けて書く。出典は区別してある: = 本人のPCのプラグイン v1.1.3、= 公開プロジェクト `make-chatgpt-site` のソース、= GitHub 公開の Sites スキル複製（実地の詰まりどころ含む）、= 本人のPCの Codex バイナリ 0.166.0 の文字列確認。

## A1. 全体経路の要約

```text
[エージェント側]
Codex セッション
├─ ローカル実行: プラグインの scripts/*.mjs（git / tar / ビルド）
└─ ツール呼び出し: codex_apps MCP サーバーの sites.* ツール
↑ 実体は Codex ランタイムが保持する接続で、
プラグイン側コードからは一切HTTPで叩いていない

[外部エージェントから使う場合]
MCPクライアント → ブリッジ(stdio MCP) → codex app-server(stdio JSON-RPC)
→ mcpServer/tool/call → codex_apps → ChatGPT Sites

[公開後のサイト]
訪問者 → https://<slug>.chatgpt.site（または <name>.openai.chatgpt.site、カスタムドメイン）
→ OpenAI運用の Dispatch（認証・公開範囲） → Cloudflare Worker
→ D1 / R2、訪問者の CONNECTORS バインディング
```

## A2. Codex app-server プロトコル（外部から叩く場合の入口）

Codex 本体には `codex app-server --stdio` という常駐モードがあり、**改行区切り JSON-RPC を標準入出力で**やり取りする。ブリッジはこれを子プロセスとして起動し、次の順序で叩いていた。

| 順 | メソッド | 主なパラメータ | 用途 |
| --- | --- | --- | --- |
| 1 | `initialize` | `clientInfo: {name, version}`、`capabilities: {experimentalApi: true, optOutNotificationMethods: ["thread/started"]}` | ハンドシェイク |
| 2 | `thread/start` | `cwd`、`ephemeral: true`、`sandbox: "read-only"`、`approvalPolicy: "never"` | 作業スレッド作成。応答の `thread.id` を以降すべてに使う |
| 3 | `app/list` | `threadId`、`limit: 100` | アプリ一覧から名前 `sites` を探し、`isEnabled` / `isAccessible` を確認 |
| 4 | `mcpServerStatus/list` | `threadId`、`detail: "toolsAndAuthOnly"`、`limit: 100` | サーバー名 `codex_apps` の状態取得。**この応答にツール定義一式（名前・説明・入力スキーマ）が辞書形式で入っている**。`authStatus` が `notLoggedIn` / `unsupported` なら利用不可 |
| 5 | `mcpServer/tool/call` | `server: "codex_apps"`、`threadId`、`tool: "sites.<操作名>"`、`arguments: {...}` | 実際のツール実行 |

ポイント: ツール定義は **Codex 本体バイナリには入っていない**（本人のPCのバイナリを文字列確認したところ `sites.` の出現は1件のみで、ツール名の一覧は存在しなかった）。定義はサーバー側から `mcpServerStatus/list` で配られるため、OpenAI はクライアントを更新せずにツール面を差し替えられる。

Codex 本体側の通信先としてバイナリから確認できたもの: 基底は `https://chatgpt.com/backend-api/`（Codex 用に `https://chatgpt.com/backend-api/codex`）、認証は `https://auth.openai.com/api/accounts` と `https://auth.openai.com/oauth/token`。つまりツール呼び出しの実通信は Codex ランタイムがこのバックエンド経由で担い、プラグインやブリッジが直接 OpenAI の HTTP API を叩く場面はない。でも、スクリプト群の HTTP 通信は npm レジストリ取得などを除き OpenAI 向けは存在しなかった。

## A3. codex_apps 上の Sites ツール完全一覧と主要な入出力

ブリッジが「上流ツール」として固定リスト化していた19件が、現行ツール面の全体像になる。名前は app-server 経由の完全名（`sites.` 区切り）。

**読み取り系（9件）**

- `sites.list_sites` — 所有サイトの一覧
- `sites.get_site` — サイト詳細（`current_live_url`、公開範囲、連携情報など）
- `sites.list_site_versions` / `sites.get_site_version` — 保存済み版の一覧・詳細
- `sites.get_deployment_status` — デプロイ状態（`deployment_id` で引く）
- `sites.get_site_worker_logs` — 稼働中 Worker のログ取得
- `sites.get_environment_variables` — 環境変数の存在確認（値は伏せて返る）
- `sites.list_custom_domains` — カスタムドメイン一覧
- `sites.refresh_custom_domain_status` — ドメイン検証状態の再確認

**書き込み系（10件）**

- `sites.create_site` — サイト作成。プロジェクト ID は `appgprj_...` 形式
- `sites.create_source_repository_write_credential` — ソースリポジトリ用クレデンシャル発行
- `sites.save_site_version` — 版の保存（引数は次節）
- `sites.deploy_site_version` / `sites.deploy_private_site_version` — 公開（公開範囲で2種）
- `sites.update_site_metadata` — タイトル等のメタデータ更新
- `sites.update_site_access` — 公開範囲の変更
- `sites.update_environment_variables` — 環境変数・シークレットの設定
- `sites.add_custom_domain` / `sites.remove_custom_domain` — カスタムドメインの付け外し

プラグイン手順書側の短縮名（第2節の表）にある `search_sites`、`remix_site`、`save_version_and_deploy_private`、`list_plugin_eligibility`、`create_schedule` / `offer_site_schedule` は、この19件には含まれていない。セッションの形態（ChatGPT ウェブ／デスクトップ／CLI）で見えるツール面が少しずつ違う、という理解が正確だと思われる。

### 公開パイプラインの引数（実地手順の形）

```text
1. sites_create_source_repository_write_credential {project_id}
→ { remote_url, branch, token（短期）, auth_mode, token_expires_at}

2. git push <remote_url> HEAD:refs/heads/<branch> （認証は次節）

3. package-site で site.tar.gz を作る（中身は A5）

4. sites_save_site_version {project_id, commit_sha, archive}
→ version_id を返す

5. sites_deploy_site_version {project_id, version_id}（公開）
または sites_deploy_private_site_version（非公開）

6. sites_get_deployment_status {project_id, version_id, deployment_id}
を succeeded / failed までポーリング
```

## A4. ソースリポジトリへの Git 経路

`site-workflow.mjs` の実コードで確認した、かなり作り込まれた経路。

- 接続先はクレデンシャルの `remote_url` をそのまま使う。**git の remote としては登録せず**、毎回 URL を直接引数に渡す。URL 書き換え設定（`url.*.insteadOf` 等）の影響を受けていたらエラーで止める
- 認証情報は `credential` オブジェクトとして **stdin の JSON でだけ**受け取る。検証項目: `remote_url`、`branch`、`token`、`auth_mode`、`token_expires_at`（期限切れは再発行を促して停止）
- `auth_mode` が `http_extra_header` の場合、トークンは環境変数 `SITES_GIT_AUTHORIZATION` に `Authorization: Bearer <token>` として入れ、git には `--config-env=http.<remote_url>.extraHeader=SITES_GIT_AUTHORIZATION` で渡す。コマンドライン引数や git config ファイルにトークンを残さない形
- ネットワーク系 git 実行時の固定オプション: `-c credential.helper=`（保存済み資格情報を使わせない）、`-c http.extraHeader=`（素の extraHeader を一旦消去）、`-c http.followRedirects=false`。`GIT_TRACE` / `GIT_CURL_VERBOSE` は環境から除去され、エラー出力中のトークンは `[redacted]` に置換される
- 開くときの手順: `git ls-remote --heads <remote_url> refs/heads/<branch>` で先行確認 → `git fetch --no-tags <remote_url> <ref>` → リモート側の `.openai/hosting.json` を `git show` で検証してからチェックアウト。履歴が分岐していたら上書きせず停止する
- 保存するときの手順: `git add --all` → コミット（メッセージは `Update Site source`）→ `git push <remote_url> <head>:refs/heads/<branch>` → `ls-remote` でプッシュ結果を再確認
- `auth_mode` が `work_proxy` の経路ではトークン自体が渡らず、Work 側が認証を肩代わりする

## A5. パッケージ（アーカイブ）の中身

`package-site.mjs` が作る `site.tar.gz` は、トップに `dist/` だけを含む。

- `dist/server/index.js` — ビルドされた Worker 本体（これが無いとデプロイは通っても配信されない、というのが次節の失敗例）
- `dist/.openai/hosting.json` — ソース側 `.openai/hosting.json` から生成されるデプロイ用メタデータ。アーカイブにこれが無いとパッケージ自体がエラーになる
- `dist/.openai/drizzle/` — D1 マイグレーション一式（プロジェクトの `drizzle/` からコピー）。ホスト側はデプロイ時にこれを適用してから Worker を上げる
- 静的ファイル一式（クライアント資産）

なお、デスクトップ版バンドルの旧世代プラグインでは同等スクリプトが `.sh`（`package-site.sh`、`init-site.sh`）で、配置も `~/.codex/plugins/cache/openai-bundled/sites/` だった。本人のPCの CLI 版 v1.1.3 は `.mjs` 化され `openai-curated-remote` 配下にある。世代で細部が動いている。

## A6. 公開後サイトの HTTP エンドポイント

サイト（Worker）自身が持つ／プラットフォームが差し込む経路。

| 経路 | 方式 | 中身 |
| --- | --- | --- |
| `/` 以下すべて | GET 等 | サイト本体。プラットフォームの Dispatch が認証と公開範囲を先に判定してから Worker に渡す |
| `/signin-with-chatgpt` | GET（トップレベル遷移） | ChatGPT サインイン開始。`?return_to=<相対パス>` 付き。プラットフォーム予約パスで、サイト側は実装禁止 |
| `/signout-with-chatgpt` | GET | サインアウト。同上 |
| `/callback` | GET | サインインのコールバック。プラットフォーム予約 |
| `/mcp` | POST（JSON-RPC、無状態） | サイトが MCP サーバー化している場合の入口（第7節）。`server/discover` / `tools/list` / `tools/call` を実装する。認証済み呼び出し元の identity ヘッダーが付いて転送される |

訪問者 identity の受け渡し（リクエストヘッダー）:

```text
oai-authenticated-user-id: <サイト内でのみ安定なID>
oai-authenticated-user-email: <検証済みメール>
oai-authenticated-user-full-name: <任意・パーセントエンコードUTF-8>
oai-authenticated-user-full-name-encoding: percent-encoded-utf-8
```

プログラムからのバイパスアクセスは別ヘッダー:

```text
OAI-Sites-Authorization: Bearer <siwc_bypass_bearer_token（get_site の応答に含まれる）>
```

ローカルプレビューでは、この認証がモックに差し替わる。`sites()` Vite プラグインが localhost 限定でクッキー `__sites_local_auth=1` を見て、固定のダミー identity（ID `local_seedy`、メール `seedy@sites.test`、名前 `Seedy`）のヘッダーを注入する。本番ビルドにはこの分岐は入らない。

## A7. サイトから接続アプリを叩く経路（ホスト側）

HTTP ではなく、Worker のバインディング呼び出しとして実装されている。

```ts
// worker/index.ts がリクエスト開始時に捕まえる
const binding = ctx.props?.CONNECTORS;

// サーバールート内での呼び出し（lib/connectors.ts 経由）
await connectorsForRequest().invoke(connectorId, actionName, validatedArgs);
```

- 呼び出しは訪問者本人の接続・同意に紐付く。バインディングをリクエストをまたいで保持してはいけない、が手順書の明記ルール
- 応答は MCP 形式の結果オブジェクトで、成否は本体の `status: "success"` で判定する（HTTP 200 や旧来の `isError` では判定しない）。`result.content` と `result.structuredContent` をそのまま扱う
- 文脈情報だけなら `getContext()` があり、宣言済みコネクタのヒント（`status`、ツール一覧など）を返すが、これは認可の証拠にはならない、と区別されている

## A8. ローカルプレビューのエンドポイントと中継プロトコル

開発時のみ存在する経路。Vite プラグイン `connector-preview-plugin.mjs` が dev サーバーに差し込む。

| 経路 | 方式 | 中身 |
| --- | --- | --- |
| `/__sites_connector_preview/context` | GET | 宣言済みコネクタのプレビュー用文脈を返す |
| `/__sites_connector_preview/invoke` | POST JSON `{connectorId, actionName, arguments}` | 接続アプリの読み取りを実行する |

- 宛先は `http://127.0.0.1:<Viteのポート>` 固定。両経路ともヘッダー `X-Sites-Preview: <起動ごとに生成されるUUIDトークン>` が必須で、無い／違うと 403 で `binding_unavailable` を返す
- Worker 側（補助 Worker `sites-connector-preview`、入口 `ConnectorPreview`）からは、サービスバインディング `CONNECTORS` として見える。本番の `ctx.props.CONNECTORS` と同じ形に揃えてある
- その先の実処理は、セッション補助プロセス `connector-preview-session.mjs` が担う。セッション情報は `.sites-runtime/connector-preview/session.json`（セッションID、有効期限、タイムアウト）に置かれ、許可リストは `.sites-runtime/connector-grants.json`（`[{connectorId, actionName, readOnly: true}]`）
- 補助プロセスとエージェントの間は **改行区切り JSON-RPC 2.0 を stdin/stdout で中継**する:

```json
{"jsonrpc":"2.0","id":"<call-id>","method":"invoke","params":{"connectorId":"<id>","actionName":"<read-action>","arguments":{}}}
```

- エージェント側は `(connectorId, actionName)` の組から実ツールへの対応表を明示的に持ち、検証してから実行する。サイト側から渡された URL や資格情報を権威として扱うことは禁止。応答は MCP 結果オブジェクトをそのまま JSON で返す
- 通知は `ready` と `receipt`、終了は `{"jsonrpc":"2.0","method":"stop"}` を送って行う。プレビュー経由は読み取りのみで、書き込みは拒否される

## A9. 実地で観測された失敗モード

- デプロイが `succeeded` と返っても、Worker として成立していない成果物（素の静的ファイルだけ等）だと **Cloudflare のルートが 404 を返す**ことがある。状態 API の成功と実際の配信は別物なので、公開後は実 URL を curl して中身を確認するのが実践側の標準手順になっている
- なお現行プラグイン v1.1.3 の手順書では、ビルドなし静的サイトも `hosting.json` の `static` 宣言による正式な手順が用意されている。上の 404 は「Worker 前提の経路に静的成果物を流した」場合の話で、手順の世代差・経路差として読むのが正確だと思われる

## A10. この付録の出典

- 本人のPC: `~/.codex/plugins/cache/openai-curated-remote/sites/1.1.3/`（`scripts/site-workflow.mjs`、`scripts/package-site.mjs`、雛形の `scripts/vite/connector-preview-plugin.mjs`、`scripts/connector-preview/*`、`scripts/vite/sites-vite-plugin.ts`、`worker/index.ts`、`lib/connectors.ts` ほか）
- GitHub `jacoblincool/make-chatgpt-site`（`src/app-server-client.mjs`、`src/tool-catalog.mjs`、`src/server.mjs`）— ローカルに clone して確認
- GitHub `agenticseo/skills` の `chatgpt-sites` スキル（公開パイプラインの引数と失敗モード）
- 本人のPCの Codex 0.166.0 バイナリの文字列（`chatgpt.com/backend-api` 基底、認証エンドポイント、app-server のメソッド名の存在、`sites.` ツール名がバイナリ内にほぼ存在しないこと）

---

# 付録A補足: 実セッションの Sites ツール一覧（本人のPCのキャッシュから）

Codex は `codex_apps` のツール定義をローカルにキャッシュしている（`~/.codex/cache/codex_apps_tools/*.json`）。本人のPCに残っていた最新キャッシュ（次節の実測実行中に更新されたもの）には、全コネクタ合計 **462 ツール**が入っており、そのうち **Sites は 39 件**だった。A3 のブリッジ固定リスト（19件）より多く、分析・DB参照・スラッグ変更などブリッジが公開していないツールも含む。入力スキーマ付きで確定できた一覧:

| ツール | 必須引数 | 任意引数 |
| --- | --- | --- |
| `sites.create_site` | `title`, `slug` | `creation_intent`, `description`, `enable_plugins`, `publish_on_push` |
| `sites.get_site` | `project_id` | `include_mcp_connection` |
| `sites.get_project` | `project_id` | — |
| `sites.list_sites` | — | `limit`, `cursor`, `role`, `include_editable` |
| `sites.list_projects` | `limit` | `cursor` |
| `sites.list_sites_creator_control_panel_projects` | — | `cursor` |
| `sites.delete_site` | `project_id` | — |
| `sites.check_slug_availability` | `slug` | `project_id` |
| `sites.change_site_slug` | `project_id`, `slug` | — |
| `sites.create_source_repository_write_credential` | `project_id` | `publish_on_push` |
| `sites.save_site_version` | `project_id`, `commit_sha` | `archive` |
| `sites.save_version_and_deploy_private` | `project_id`, `commit_sha` | `archive` |
| `sites.deploy_site_version` | `project_id`, `version_id` | `tunnel_bindings` |
| `sites.deploy_private_site_version` | `project_id`, `version_id` | `tunnel_bindings` |
| `sites.get_deployment_status` | `project_id`, `deployment_id` | `version_id` |
| `sites.list_site_versions` | `project_id` | `limit`, `cursor` |
| `sites.get_site_version` | `project_id`, `version_id` | — |
| `sites.update_site_metadata` | `project_id`, `title` | — |
| `sites.update_site_access` | `project_id` | `access_mode`, `allowed_user_emails`, `allowed_workspace_group_ids`, `allowed_tenant_group_ids`, `editor_changes`, `viewer_changes` |
| `sites.update_access` | `project_id`, `access_mode` | `allowed_user_emails`, `allowed_workspace_group_ids`, `allowed_tenant_group_ids` |
| `sites.get_environment` / `sites.get_environment_variables` | `project_id` | — |
| `sites.update_environment` / `sites.update_environment_variables` | `project_id`, `set_values` | `remove` |
| `sites.generate_siwc_bypass_token` | `project_id` | — |
| `sites.get_database_overview` / `sites.read_database_overview` | `project_id` | `binding_name` |
| `sites.get_database_table_rows` / `sites.read_database_table_rows` | `project_id`, `table_name` | `binding_name`, `limit`, `offset` |
| `sites.get_site_worker_logs` | `project_id` | `since_minutes`, `limit`, `errors_only` |
| `sites.list_custom_domains` | `project_id` | — |
| `sites.add_custom_domain` | `project_id`, `hostname` | — |
| `sites.remove_custom_domain` | `project_id`, `custom_domain_id` | — |
| `sites.refresh_custom_domain_status` | `project_id`, `custom_domain_id` | — |
| `sites.get_site_analytics_overview` | `project_id`, `start_time_ms`, `end_time_ms` | `view`, `granularity` |
| `sites.list_site_analytics_events` | `project_id`, `start_time_ms`, `end_time_ms` | — |
| `sites.query_site_analytics_event` | `project_id`, `start_time_ms`, `end_time_ms`, `event_name` | — |
| `sites.create_schedule` | `project_id`, `request_id`, `task` | — |
| `sites.validate_suggested_schedule` | `project_id`, `schedule_suggestion` | — |

出力スキーマから分かることもある。`sites.create_site` の応答には `source_repository_credential` が含まれ（作成と同時にソース資格情報が返る）、`sites.get_site` の応答には `siwc_bypass_bearer_token`、`mcp_connection`、`automations`、`access_policy`、`auth_client_id`、`current_preview_url`、`current_live_url`、`screenshot_url` などが並ぶ。`sites.save_site_version` の応答は `version_number`、`archive_storage`、`deployment_id` を返す。

なお `get_database_overview` と `read_database_overview` のような同義ペアが併存していて、ツール面が移行中であることもキャッシュから見て取れる。

---

# 付録B: Codex 本体の外部通信

「Codex の中から外へ、どう通信しているか」を、公式ソース（openai/codex の `rust-v0.166.0`、本人のバイナリと同版）と、自宅PCでの実測で整理する。

## B1. 実測: 1回の最小実行で出た通信

自宅PCに CONNECT ログだけを取る素通しプロキシ（TLS の中身は見ない）を置き、環境変数 `HTTPS_PROXY` / `HTTP_PROXY` を向けて `codex exec` で「ok とだけ返せ」という最小タスクを実行した（2026-11-06 19:26 JST、所要約10秒）。

| 宛先ホスト | 本数 | 読み |
| --- | --- | --- |
| `chatgpt.com:443` | 17 | API 通信のほぼ全部。モデル応答、ツール基盤、アカウント確認などが同じホストに同居している（パスは B2） |
| `sdmntprcentralus.oaiusercontent.com:443` | 1 | OpenAI のコンテンツ配信用ホスト（アプリ情報や素材など、サーバーが返した URL への取得とみられる） |
| `ab.chatgpt.com:443` | 1 | テレメトリ（メトリクス送信先。バイナリ内に `https://ab.chatgpt.com/otlp/v1/metrics` を確認） |

この実行で消費トークンは 23,444 と表示された。「ok」の一言に対してこの量なのは、システム指示・スキル一覧・ツール定義（キャッシュでは462件分）など、毎ターンの文脈が大きいことの表れ。

CONNECT の性質上、見えるのはホスト名までで、パスや中身は見ていない（MITM はしていない）。パス単位の対応は次のソース確認に基づく。また、この実行の最中に `~/.codex/cache/codex_apps_tools/` のキャッシュが更新されており（ファイル更新時刻 19:26:18）、ツール定義の再取得が起動系通信の一部に含まれていたことが裏付けられた。

## B2. 経路別の一覧（公式ソースで確認）

### (1) モデル応答 — 主経路

- 宛先: **`POST https://chatgpt.com/backend-api/codex/responses`**（ChatGPT サブスクリプション認証時）。API キー利用時は `https://api.openai.com/v1/responses`
- 形式: Responses API。リクエストは `stream: true` の **SSE ストリーミング**が基本形で、本体フィールドは `model`、`input`（会話・指示・ツール結果の列）、`tools`（ツール定義一式）、`tool_choice`、`parallel_tool_calls`、`reasoning`、`store`、`include`、`prompt_cache_key`、`client_metadata` など（`codex-api/src/common.rs` の `ResponsesApiRequest`）
- WebSocket 版も実装されている（`codex-api/src/endpoint/responses_websocket.rs`。宛先は基底 URL から導出され、`previous_response_id` で継続する形）。プロバイダが WebSocket 対応の場合に使われる
- 主なヘッダー: `Authorization: Bearer <ChatGPT OAuth アクセストークン>`、`chatgpt-account-id`（トークンの `https://api.openai.com/auth` クレームから抽出）、`originator`、`session_id`、`x-codex-turn-metadata`、`x-codex-window-id`、`x-codex-installation-id` など。利用率の応答ヘッダー（`x-codex-primary-used-percent` 等）で残量を読み取る作り
- 本人の設定: モデル `gpt-6.1-sol`、reasoning effort `high`、service tier `fast`（`~/.codex/config.toml`）

### (2) モデルカタログ

- `GET https://chatgpt.com/backend-api/codex/models`（と `/codex/other-models`）。取得結果は `~/.codex/models_cache.json` にキャッシュされる

### (3) コネクタ／ツール基盤（codex_apps）

- 宛先: **`https://chatgpt.com/backend-api/ps/mcp`** — Codex 本体が MCP クライアントとして接続する、Streamable HTTP のリモート MCP サーバー。URL はソースで `{chatgpt_base_url}/ps/mcp` と組み立てられる（`codex-mcp/src/mcp/mod.rs`）
- サーバー自己紹介は `name: "plugin-runtime"`, `version: "0.1.0"`（本人のPCのキャッシュ `codex_apps_server_info` で確認）
- `initialize` → `tools/list` でツール一式を取得し、`~/.codex/cache/codex_apps_tools/*.json` にキャッシュ（本人の環境では 6 MB、462 ツール）。ツール実行は `tools/call`。認証は ChatGPT の OAuth トークン。切断時の再接続は 1 秒→最大 30 秒のバックオフ（`codex-mcp/src/rmcp_client.rs`）
- **Sites のツール呼び出しもこの1本に同居している**。つまり Sites 操作は専用回線ではなく、他の全コネクタと同じ MCP 接続の1名前空間として流れている
- ユーザーが自分で追加した MCP サーバーについては、設定された URL へ直接（HTTP）またはローカルプロセス（stdio）で接続し、OAuth が要るものは `/.well-known/oauth-*` の探索から認可フローを回す

### (4) プラグイン基盤

- `GET /backend-api/ps/plugins/list`、`.../ps/plugins/installed`、`POST .../ps/plugins/{remote_id}/install` / `uninstall`、`.../ps/plugins/search`、`.../ps/apps/batch`
- カタログ系: `GET /backend-api/plugins/export/curated`、`/backend-api/plugins/featured`、`/backend-api/connectors/directory/list`
- 取得したカタログは `~/.codex/cache/remote_plugin_catalog/` にキャッシュされ、プラグイン実体は `~/.codex/plugins/cache/` に展開される（Sites プラグインもこの経路で届いた）

### (5) 認証

- ログイン: ブラウザで `https://auth.openai.com/oauth/authorize` を開き、ローカルホストのコールバックで受け取る方式。デバイスコード方式用に `/api/accounts/deviceauth/usercode` と `/api/accounts/deviceauth/token` もある
- トークン更新: `POST https://auth.openai.com/oauth/token`（フォーム形式、リフレッシュトークン方式）。失効は `/oauth/revoke`
- トークンの置き場は `~/.codex/auth.json`。モデル応答や MCP 接続の Bearer はここから供給される

### (6) アカウント・利用量

- `GET /backend-api/wham/accounts/check` — アカウント状態・利用可否の確認
- `/backend-api/accounts/switch-workspace-token`、`/backend-api/accounts/verified_access` — ワークスペース切替や確認済みアクセス用

### (7) テレメトリ

- 製品アナリティクス: `POST {base_url}/codex/analytics-events/events`（`analytics/src/client.rs`）
- メトリクス: OTLP で `https://ab.chatgpt.com/otlp/v1/metrics`（実測でも `ab.chatgpt.com` への接続を確認）

### (8) ファイル・コンテンツ

- 添付のアップロード完了通知など: `/backend-api/files/{file_id}/uploaded`
- コンテンツ取得: サーバーが返す `*.oaiusercontent.com` の URL へ直接（実測の `sdmntprcentralus.oaiusercontent.com`）

### (9) ソースにはあるが今回の実測では出ていないもの

- 音声リアルタイム: `/backend-api/codex/realtime/calls`（WebSocket 系）
- リモートコントロール（デスクトップ／モバイル連携）: `/backend-api/wham/remote/control/environments`、`.../server/enroll`、`.../server/pair` など
- エージェント ID 基盤: `https://auth.openai.com/api/accounts/v1/agent/register`、JWKS は `/backend-api/wham/agent-identities/jwks`

### (10) 外に出ないもの

- シェルコマンド実行、ファイル読み書き、パッチ適用はローカルで完結する
- MCP の stdio サーバーはローカルプロセス起動
- Git 操作はプロジェクトのリモート先へ直接（Sites の場合は A4 の `remote_url` へ、Bearer ヘッダー付き）。Codex のサーバーを経由しない

## B3. まとめとして言えること

- Codex の外部通信は、事実上 **`chatgpt.com` の `/backend-api/` 配下に集約**されている。モデル応答（`/codex/responses`）、ツール（`/ps/mcp`）、プラグイン（`/ps/plugins/*`）、アカウント（`/wham/*`）、アナリティクス（`/codex/analytics-events/events`）が同じホスト・同じ OAuth トークンで束ねられている
- 例外は認証ドメイン `auth.openai.com` と、テレメトリの `ab.chatgpt.com`、コンテンツ配信用の `*.oaiusercontent.com`、そして API キーモード時の `api.openai.com` くらい
- Sites のような「機能」は、この集約の上に **MCP の名前空間＋ローカルプラグイン**として載っている。だから新機能の追加は、Codex 本体の改修ではなく、サーバー側のツール配布とプラグイン配布で完結する作りになっている

## B4. この付録の出典

- 公式ソース: GitHub `openai/codex` のタグ `rust-v0.166.0` を clone して確認（`codex-api/`、`codex-mcp/`、`model-provider/`、`analytics/`、`app-server/` ほか）
- 実測: 自宅PCに設置した CONNECT ログ用プロキシ経由の `codex exec` 実行ログ（2026-11-06 19:26 JST）と、その際に更新された `~/.codex/cache/codex_apps_tools/` の実物
- 本人の設定値: `~/.codex/config.toml`（モデル等の非シークレット項目のみ）

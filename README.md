# @hayatosc/sites

ChatGPT Sites をコマンドラインから操作する CLI です。Node.js 22.13 以上が必要です。

```sh
npx @hayatosc/sites --help
```

## 認証

Codex CLI の認証情報 (`~/.codex/auth.json`) をそのまま利用します。`SITES_ACCESS_TOKEN` を設定すると、そのトークンを優先します。CLI 独自のログインやトークン保存は行いません。

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check   # MCP へ接続して確認
```

## はじめかた

```sh
mkdir my-site && cd my-site
npx @hayatosc/sites init --template static
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`init` は `.openai/hosting.json` とビルド用の雛形を作ります。`create` はサイトを作成し、返された `project_id` を `hosting.json` に保存します。`deploy` はビルド、ソース同期、アップロード、デプロイまでを実行します。

## コマンド

| コマンド                                         | 説明                                   |
| ------------------------------------------------ | -------------------------------------- |
| `sites init [dir] --template static\|worker-esm` | プロジェクトの雛形を作成               |
| `sites create <slug>`                            | サイトを作成して `project_id` を保存   |
| `sites list`                                     | サイト一覧                             |
| `sites info [project\|slug]`                     | サイトの詳細                           |
| `sites deploy`                                   | ビルドしてデプロイ                     |
| `sites status [deployment_id]`                   | デプロイ状態 (`--watch` で待機)        |
| `sites logs`                                     | Worker ログ (`--follow` で追跡)        |
| `sites versions list\|show\|rollback`            | バージョン一覧・詳細・切り戻し         |
| `sites env list\|get\|set\|unset\|pull\|push`    | 環境変数                               |
| `sites access show\|set`                         | 公開範囲                               |
| `sites domains add\|list\|refresh\|remove`       | カスタムドメイン                       |
| `sites analytics summary\|events`                | アクセス解析                           |
| `sites open`                                     | ブラウザで開く (`--print` で URL のみ) |
| `sites delete --yes`                             | サイトを削除                           |
| `sites doctor`                                   | ローカル環境と接続の診断               |
| `sites cli search <query>`                       | コマンドの検索                         |
| `sites docs search <query>`                      | 同梱ドキュメントの検索                 |
| `sites schema [tool]`                            | MCP ツールの入力スキーマ               |

各コマンドのフラグは `sites <command> --help` で確認できます。

## 出力と終了コード

既定の出力は JSON です。`--human` を付けると人間向けの表示になります。進捗や警告は stderr に流れ、`--quiet` で抑制できます。

| コード | 意味                             |
| ------ | -------------------------------- |
| 0      | 成功                             |
| 1      | 一般エラー、デプロイ失敗         |
| 2      | 引数の誤り                       |
| 3      | 認証エラー                       |
| 4      | 通信エラー、タイムアウト         |
| 5      | 事前検査の失敗                   |
| 6      | 競合 (slug 重複、ソース変更など) |
| 130    | 中断                             |

## wrangler からの変換

`wrangler.jsonc` / `wrangler.json` / `wrangler.toml` がある場合、`deploy` は設定を `.openai/hosting.json` に変換し、Worker を Rolldown でバンドルします。未対応のバインディングがある場合は書き込まずに停止します。意図的に続行する場合は `--allow-unsupported <kind>` を指定します。

## 開発

```sh
ni
nlx vp check
nlx vp test
nlx vp pack
```

`dist/cli.mjs` が実行ファイルです。ビルド・テスト・lint・整形・型チェックは Vite+ (`vp`) に統一しています。利用者向けマニュアルは `docs/manual/` にあり、ビルド時に CLI へ埋め込まれるため、`sites docs search` は外部の `docs/` を必要としません。

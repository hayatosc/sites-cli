# リファレンス

## グローバルフラグ

グローバルフラグはコマンドの前後どちらにも指定できます。

| フラグ             | 説明                                       |
| ------------------ | ------------------------------------------ |
| `--json`           | JSON で出力する（既定）                    |
| `--human`          | 人間向けに出力する                         |
| `-q`, `--quiet`    | 進捗表示を抑制する                         |
| `--profile <name>` | 使用するプロファイル                       |
| `--no-color`       | 色を無効にする                             |
| `-y`, `--yes`      | 確認をスキップする                         |
| `-h`, `--help`     | ヘルプを表示する                           |
| `-v`, `--version`  | バージョンを表示する                       |

`NO_COLOR` が設定されている場合も色は無効になります。

## コマンド一覧

| コマンド                                             | 説明                                 |
| ---------------------------------------------------- | ------------------------------------ |
| `auth whoami [--check]`                              | 認証情報と接続を確認                 |
| `init [dir] --template static\|worker-esm`           | プロジェクトの雛形を作成             |
| `create <slug>`                                      | サイトを作成して ID を保存           |
| `list`                                               | サイト一覧                           |
| `info [project\|slug]`                               | サイトの詳細                         |
| `deploy`                                             | ビルドしてデプロイ                   |
| `status [deployment_id]`                             | デプロイ状態                         |
| `logs`                                               | Worker ログ                          |
| `versions list`                                      | バージョン一覧                       |
| `versions show <version_id>`                         | バージョンの詳細                     |
| `versions rollback <version_id\|--previous>`         | バージョンを切り戻す                 |
| `env list`                                           | 環境変数一覧                         |
| `env get <key>`                                      | 環境変数の取得                       |
| `env set <key> <value>`                              | 環境変数の設定                       |
| `env unset <key>`                                    | 環境変数の削除                       |
| `env pull`                                           | 環境変数をローカルへ書き出す         |
| `env push`                                           | ローカルの環境変数を反映             |
| `access show`                                        | 公開範囲を表示                       |
| `access set`                                         | 公開範囲を変更                       |
| `domains add <hostname>`                             | カスタムドメインを追加               |
| `domains list`                                       | カスタムドメイン一覧                 |
| `domains refresh <hostname\|id>`                     | ドメインの状態を更新                 |
| `domains remove <hostname\|id>`                      | カスタムドメインを削除               |
| `analytics summary`                                  | アクセス解析の概要                   |
| `analytics events`                                   | アクセス解析のイベント               |
| `open [project\|slug]`                               | ブラウザで開く                       |
| `delete [project\|slug]`                             | サイトを削除                         |
| `doctor`                                             | 環境と接続を診断                     |
| `cli search <query>`                                 | コマンドを検索                       |
| `docs search <query>`                                | このマニュアルを検索                 |
| `schema [tool]`                                      | MCP ツールの入力スキーマ             |

## 環境変数

| 変数                       | 説明                                             |
| -------------------------- | ------------------------------------------------ |
| `SITES_ACCESS_TOKEN`       | 使用するアクセストークン                         |
| `SITES_AUTH_PATH`          | Codex の認証ファイルのパス                       |
| `SITES_AUTH_URL`           | トークン更新のエンドポイント                     |
| `SITES_MCP_URL`            | MCP サーバーの URL                               |
| `SITES_API_BASE`           | ファイル API のベース URL                        |
| `SITES_RETRY_BASE_MS`      | レート制限時の再試行の基準時間                   |
| `SITES_UPLOAD_POLL_MS`     | アップロード完了確認の間隔                       |
| `SITES_LOG_INTERVAL_MS`    | `logs --follow` のポーリング間隔                 |
| `SITES_ALLOW_INSECURE_GIT` | `1` のときテスト用の `file://` リモートを許可    |
| `NO_COLOR`                 | 色を無効にする                                   |

通常の利用では、これらを設定する必要はありません。

## 状態ファイル

`.sites/state.json` は CLI が管理します。編集する必要はありません。`deploy --tag` のタグもここに保存されます。

## 認証ファイル

`~/.codex/auth.json` は Codex CLI と共有します。`sites` は次の場合にだけ書き換えます。

- アクセストークンが期限切れで、リフレッシュトークンがある
- 401 を受け取り、強制更新が必要になった

書き込みは一時ファイルと rename で行い、パーミッションは `0600` です。`auth_mode`、`OPENAI_API_KEY`、`tokens.account_id` は保持します。

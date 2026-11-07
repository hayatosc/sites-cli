# sites マニュアル

`sites` は ChatGPT Sites の作成、デプロイ、運用をコマンドラインから行う CLI です。Codex CLI の認証情報を利用するため、別途ログインする必要はありません。

## インストールと実行

Node.js 22.13 以上が必要です。インストールせずに実行する場合は `npx` を使います。

```sh
npx @hayatosc/sites --help
npx @hayatosc/sites auth whoami
```

特定のバージョンを使い続ける場合は、プロジェクトの開発依存に追加します。

```sh
ni -D @hayatosc/sites
npx sites --version
```

## 認証

認証トークンは次の順で解決されます。

1. 環境変数 `SITES_ACCESS_TOKEN`
2. `~/.codex/auth.json` の `tokens.access_token`

`~/.codex/auth.json` のトークンが期限切れの場合は、リフレッシュトークンで更新し、元のファイルへ `0600` で書き戻します。CLI 独自のログイン情報やトークンストアは作りません。

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check
```

`--check` は MCP サーバーへ接続し、認証と接続の両方を確認します。

## はじめてのデプロイ

```sh
mkdir my-site && cd my-site
npx @hayatosc/sites init --template static
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`init` は `.openai/hosting.json` とビルド用の雛形を作ります。`create` はサイトを作成し、返された `project_id` を `hosting.json` に保存します。`deploy` はビルド、ソース同期、アップロード、デプロイをまとめて実行します。

## 出力形式

既定の出力は JSON です。エージェントやスクリプトからは JSON をそのまま扱えます。

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "duration_ms": 120,
    "request_id": "req_..."
  }
}
```

人間向けの表示には `--human` を指定します。進捗、警告、診断は stderr に出力され、`--quiet` で進捗を抑制できます。エラーは JSON の場合 `ok: false` と `error.code`、`error.message`、`error.hint` を返します。

## 終了コード

| コード | 意味                                       |
| ------ | ------------------------------------------ |
| 0      | 成功                                       |
| 1      | 一般エラー、デプロイ失敗                   |
| 2      | 引数の誤り                                 |
| 3      | 認証エラー                                 |
| 4      | 通信エラー、タイムアウト                   |
| 5      | 事前検査の失敗                             |
| 6      | 競合（slug 重複、ソース変更など）          |
| 130    | 中断（SIGINT）                             |

## ドキュメントの検索

`sites docs search` は、このマニュアルを CLI に埋め込んだ内容から検索します。ネットワークやリポジトリの `docs/` ディレクトリは不要です。

```sh
npx @hayatosc/sites docs search "カスタムドメイン"
npx @hayatosc/sites docs search "deploy dry-run"
```

コマンド名から探す場合は `sites cli search` を使います。

```sh
npx @hayatosc/sites cli search "環境変数"
```

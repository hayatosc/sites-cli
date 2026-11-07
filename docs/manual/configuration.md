# 設定

## .openai/hosting.json

サイトの設定は `.openai/hosting.json` に置きます。`init` が最小限のファイルを作り、`create` が `project_id` を書き込みます。

```json
{
  "project_id": "appgprj_xxx",
  "static": {
    "directory": "dist",
    "not_found_handling": "404-page"
  }
}
```

| キー                     | 説明                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `project_id`             | Sites のプロジェクト ID。未作成なら `null`                   |
| `static`                 | 静的サイトの設定。Worker のみなら省略                        |
| `static.directory`       | 成果物のディレクトリ。デプロイ時に `dist` として扱われる     |
| `static.not_found_handling` | `none`、`404-page`、`single-page-application`            |
| `d1`                     | D1 バインディング名。例: `"DB"`                               |
| `r2`                     | R2 バインディング名。例: `"BUCKET"`                           |
| `capabilities`           | 追加機能。現在は `["mcp"]` のみ                              |

`plugins` と `connectors` は予約済みです。API が受け付けないキーを追加するとデプロイに失敗します。

## 静的サイト

`static.directory` に HTML などの成果物を置きます。`dist/index.html` が必須です。API に送るマニフェストでは `directory` を `dist` に書き換えます。

`not_found_handling` は次のいずれかです。

- `none`: 404 をそのまま返す
- `404-page`: `404.html` を返す
- `single-page-application`: すべてのパスを `index.html` にフォールバックする

## Worker サイト

Worker は `dist/server/index.js` を単一の ESM として配置します。`export default` が必要です。

- `cloudflare:*` と `node:*` 以外の import は許可されません。
- 相対 import、`require()`、`import.meta.url` を使ったファイル読み込みは許可されません。
- `.wasm` やバイナリファイルの import は許可されません。
- `assets.directory` を指定した場合、静的ファイルは `dist/client` に配置されます。

静的ファイルと Worker を同時に使う場合、`static` と `d1` / `r2` / `capabilities` の併用はできません。静的サイトにバインディングを付けるとデプロイ時に拒否されます。

## D1

`d1` にバインディング名を指定すると、`drizzle/` のマイグレーションがデプロイ時に適用されます。マイグレーションは `dist/.openai/drizzle/` に含まれ、Worker の起動前に実行されます。

- ファイル名の辞書順で適用されます。`0001_init.sql` のようにゼロ埋めしてください。
- 適用済みの管理テーブルは `__appgarden_migrations` です。
- 複数の D1 バインディングには対応していません。

## R2

`r2` にバインディング名を指定すると、Worker から R2 バケットを利用できます。複数の R2 バインディングには対応していません。

## 環境変数

デプロイ時の `--env-file` で、`KEY=VALUE` 形式のファイルを読み込みます。値は Sites の環境変数として保存され、次回のデプロイから反映されます。

```sh
npx @hayatosc/sites deploy --env-file .env.production
```

秘密情報は `sites env set KEY VALUE --secret` で設定します。秘密情報の値は API から読み出せません。

## wrangler からの変換

`wrangler.jsonc`、`wrangler.json`、`wrangler.toml` がある場合、`deploy` は設定を `.openai/hosting.json` に変換します。変換元は次の順で探します。

1. `wrangler.jsonc`
2. `wrangler.json`
3. `wrangler.toml`

変換される主な項目は次のとおりです。

| wrangler                       | hosting.json                     |
| ------------------------------ | -------------------------------- |
| `name`                         | slug とタイトルの候補            |
| `main`                         | `dist/server/index.js` へバンドル |
| `assets.directory`             | `dist/client`                    |
| `assets.not_found_handling`    | `static.not_found_handling`      |
| `d1_databases[0].binding`      | `d1`                             |
| `r2_buckets[0].binding`        | `r2`                             |
| `migrations_dir`               | `dist/.openai/drizzle`           |

`vars`、crons、routes、compatibility flags などは警告として報告されます。`vars` はデプロイ時の環境変数として別途設定してください。

## 未対応機能

次の機能は自動変換できません。検出すると、何も書き込まずに停止します。

- KV、Durable Objects、Queues、Services、Hyperdrive、Vectorize
- Workers AI、Browser Rendering
- `[[rules]]`
- `.wasm` の import
- 複数の D1 または R2 バインディング
- 単一 ESM の制約に反する Worker

意図的に続行する場合は、該当する種類を `--allow-unsupported` に指定します。変換レポートには、未変換の項目が残ります。

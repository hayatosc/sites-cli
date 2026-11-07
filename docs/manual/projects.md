# プロジェクト

サイトは `project_id`（`appgprj_...`）で識別されます。`init` と `create` はこの ID を `.openai/hosting.json` に保存します。以降のコマンドは、引数を省略すると保存された ID を使います。

## sites init

新しいサイトの雛形をカレントディレクトリ、または指定したディレクトリに作ります。

```sh
npx @hayatosc/sites init
npx @hayatosc/sites init my-site --template worker-esm
```

| フラグ             | 説明                                       |
| ------------------ | ------------------------------------------ |
| `--template <name>` | `static`（既定）または `worker-esm`       |
| `--force`          | 空でないディレクトリにも作成する           |
| `--no-git`         | Git リポジトリを初期化しない               |

`static` は `public/index.html` と、`public/` を `dist/` にコピーするビルドスクリプトを作ります。`worker-esm` は `worker/index.js` と、Worker を `dist/server/index.js` にコピーするビルドスクリプトを作ります。

## sites create

サイトを作成し、`project_id` を `hosting.json` に保存します。既に `project_id` が保存されている場合は、誤って別のサイトを作らないよう停止します。

```sh
npx @hayatosc/sites create my-site
npx @hayatosc/sites create my-site --title "My Site" --public
```

| フラグ             | 説明                                             |
| ------------------ | ------------------------------------------------ |
| `--title <title>`  | サイトの表示名                                   |
| `--private`        | 非公開（既定）                                   |
| `--public`         | 公開                                             |
| `--workspace`      | ワークスペース内に公開                           |
| `--description <text>` | 説明                                         |
| `--dry-run`        | API を呼ばずに確認だけ行う                       |

slug は小文字英数字とハイフンで、先頭は英字です。使用済みの slug は作成できません。

## sites list

自分がアクセスできるサイトを一覧します。

```sh
npx @hayatosc/sites list
npx @hayatosc/sites list --all --role owner
```

| フラグ             | 説明                                             |
| ------------------ | ------------------------------------------------ |
| `--limit <n>`      | 1 ページの件数（1〜100、既定 20）                |
| `--cursor <cursor>` | 続きのページを取得                              |
| `--role <role>`    | `owner`、`editor`、`viewer` で絞り込む           |
| `--all`            | カーソルをたどって全件取得                       |

## sites info

サイトの詳細、最新バージョン、カスタムドメインを表示します。

```sh
npx @hayatosc/sites info
npx @hayatosc/sites info my-site
npx @hayatosc/sites info appgprj_xxx --mcp
```

`--mcp` を指定すると MCP 接続情報も取得します。

## sites open

サイトをブラウザで開きます。URL だけが必要な場合は `--print` を使います。

```sh
npx @hayatosc/sites open
npx @hayatosc/sites open my-site --path /pricing
npx @hayatosc/sites open --print
```

`--print` は URL を 1 行だけ stdout に出力します。`--path` はサイトの URL にパスを追加します。

## sites delete

サイトを削除します。元に戻せません。

```sh
npx @hayatosc/sites delete my-site
npx @hayatosc/sites delete --yes
```

対話できない環境では `--yes` が必須です。削除後、`hosting.json` の `project_id` は `null` に戻り、その他の設定は保持されます。

## プロジェクトの状態ファイル

`.sites/state.json` に、直近のデプロイ情報が保存されます。

- `last_deployment_id`: 直近のデプロイ ID
- `last_version_id`: 直近のバージョン ID
- `last_commit_sha`: ソース同期で作られたコミット
- `last_artifact_hash`: アップロードした成果物のハッシュ
- `tags`: `deploy --tag` で付けたローカルタグ
- `last_rate_limited_at`: 直近のレート制限時刻

このファイルは Git にコミットしません。`.sites/` は `init` が `.gitignore` に追加します。

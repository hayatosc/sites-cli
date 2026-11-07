# デプロイ

## sites deploy

`deploy` は次の一連の処理を 1 コマンドで実行します。

1. 事前検査（マニフェスト、成果物、サイズ、未コミット変更）
2. ビルド
3. ソース同期
4. アーカイブ作成
5. アップロード
6. バージョン保存
7. デプロイと状態のポーリング

```sh
npx @hayatosc/sites deploy
npx @hayatosc/sites deploy --dry-run
npx @hayatosc/sites deploy --message "Update pricing page"
```

| フラグ                     | 説明                                                     |
| -------------------------- | -------------------------------------------------------- |
| `--dry-run`                | ビルドと事前検査だけ行う。認証情報もアップロードも不要   |
| `--no-build-script`        | `package.json` の `build` を実行しない                   |
| `--message <message>`      | ソース同期のコミットメッセージ                           |
| `--tag <tag>`              | ローカルの状態ファイルにタグを保存する                   |
| `--private`                | デプロイ後に非公開にする                                 |
| `--public`                 | デプロイ後に公開する                                     |
| `--workspace`              | デプロイ後にワークスペース内へ公開する                   |
| `--env-file <path>`        | デプロイ時に環境変数を設定する                           |
| `--no-source-sync`         | ソース同期をスキップする                                 |
| `--allow-dirty`            | 未コミットの変更があっても続行する                       |
| `--allow-unsupported <kinds>` | 未対応の wrangler 機能を警告に降格する（カンマ区切り） |
| `--timeout <seconds>`      | デプロイ状態の待機時間（既定 300）                       |

公開範囲を変更するオプションは複数指定できません。`--public` を対話環境以外で使う場合は `--yes` も指定します。

## ソース同期

`deploy` はプロジェクトのソースを Sites の Git リポジトリへ同期します。同期は一時ディレクトリで行い、作業中のリポジトリの履歴やリモート設定を変更しません。

- リモートの最新コミットを取得してから、ワーキングツリーの内容を上書きします。
- `.git`、`node_modules`、`dist`、`.sites`、`outputs` は同期しません。
- 認証情報は Git の設定に保存せず、その場限りの HTTP ヘッダーとして渡します。
- 同期後にリモートのコミットを確認し、競合を検出します。

未コミットの変更がある場合は、既定で `CONFLICT_DIRTY_TREE`（終了コード 5）で停止します。意図的に含める場合は `--allow-dirty` を指定します。ソース同期を止める場合は `--no-source-sync` を指定しますが、その場合は直近のコミットが必要です。

## ビルド

`package.json` に `build` スクリプトがあれば、使用中のパッケージマネージャーで実行します。`--no-build-script` を指定すると実行しません。

ビルドスクリプトがない場合は、プロジェクトの種類に応じて成果物を用意します。

- 静的サイト: `public/` を `dist/` にコピー
- Worker: `worker/index.js` を `dist/server/index.js` にコピー
- wrangler プロジェクト: `main` を Rolldown で `dist/server/index.js` にバンドル

`dist/index.html`（静的）または `dist/server/index.js`（Worker）が無い場合は事前検査で停止します。

## アーカイブ

アップロードする tar.gz は `dist/` をルートに持ち、`.openai/hosting.json` を含みます。D1 を使う場合は `dist/.openai/drizzle/` にマイグレーションを配置します。

- シンボリックリンクや特殊ファイルは含められません。
- 展開後のサイズが 512 MiB を超える場合は停止します。
- アーカイブは一時ディレクトリに作り、プロジェクト内には残しません。
- `upload_url` や `download_url` はログに表示しません。

## バージョン保存の重複

Sites は同じ `commit_sha` に対するバージョン保存を重複として扱い、既存バージョンを返すことがあります。成果物が変わっているのにコミットが変わっていない場合は、CLI が空コミットを作って新しいバージョンとして保存します。

## sites status

デプロイ状態を表示します。引数を省略すると `.sites/state.json` の直近のデプロイを使います。

```sh
npx @hayatosc/sites status
npx @hayatosc/sites status <deployment_id> --watch
```

| フラグ             | 説明                                       |
| ------------------ | ------------------------------------------ |
| `--watch`          | 終了状態になるまでポーリングする           |
| `--interval <sec>` | ポーリング間隔（既定 3）                   |
| `--timeout <sec>`  | 待機時間（既定 300）                       |

状態が `failed` または `error` の場合は終了コード 1 で終わり、`failure_message` を表示します。

## sites logs

Worker のログを取得します。ログは要求時に取得する方式です。

```sh
npx @hayatosc/sites logs
npx @hayatosc/sites logs --since 2h --errors-only
npx @hayatosc/sites logs --follow
```

| フラグ             | 説明                                             |
| ------------------ | ------------------------------------------------ |
| `--since <window>` | `30m`、`2h`、`1d` のような期間（既定 30m）       |
| `--limit <n>`      | 取得件数（1〜1000、既定 100）                    |
| `--errors-only`    | エラーだけ取得する                               |
| `--all`            | エラー以外も含める（`--errors-only` より優先）   |
| `--follow`         | 5 秒間隔で追跡する                               |

レート制限を受けた場合、`--follow` は間隔を倍にしながら最大 60 秒まで待機します。

## デプロイ失敗時

1. `sites status <deployment_id>` で `failure_message` を確認する
2. `sites logs --errors-only --since 1h` で Worker の例外を確認する
3. `sites doctor` で認証、マニフェスト、Git、成果物を確認する
4. 必要なら `sites versions rollback <version_id>` で直前のバージョンに戻す

デプロイが `failed` になっても、保存済みのバージョンは残ります。

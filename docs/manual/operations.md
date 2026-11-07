# 運用

## バージョン

デプロイごとにバージョンが保存されます。バージョンを指定して切り戻せます。

```sh
npx @hayatosc/sites versions list
npx @hayatosc/sites versions show <version_id>
npx @hayatosc/sites versions rollback <version_id>
npx @hayatosc/sites versions rollback --previous
```

`--previous` は一覧の 2 番目、つまり現在の最新の 1 つ前のバージョンを使います。ロールバックは既存バージョンを再デプロイするだけで、新しいバージョンは作りません。カスタムアクセスのサイトでは非公開デプロイ、それ以外では通常デプロイを使います。

## 環境変数

```sh
npx @hayatosc/sites env list
npx @hayatosc/sites env get API_URL
npx @hayatosc/sites env set API_URL https://example.com
npx @hayatosc/sites env set API_KEY secret-value --secret
npx @hayatosc/sites env unset API_URL
```

`env set` と `env unset` の変更は、次回のデプロイで反映されます。保存だけでは稼働中のサイトは変わりません。

`env pull` は `.env` をローカルに書き出します。秘密情報の値は API から取得できないため、キー名だけをコメントとして出力します。

```sh
npx @hayatosc/sites env pull
npx @hayatosc/sites env pull --out .env.local
```

`env push` は `.env` の内容をまとめて設定します。`--dry-run` で送信内容を確認できます。

```sh
npx @hayatosc/sites env push --env-file .env
npx @hayatosc/sites env push --env-file .env --dry-run
```

## 公開範囲

```sh
npx @hayatosc/sites access show
npx @hayatosc/sites access set --private
npx @hayatosc/sites access set --public
npx @hayatosc/sites access set --workspace
npx @hayatosc/sites access set --private --allow-email user@example.com
```

`--private`、`--public`、`--workspace` は同時に指定できません。`--allow-email` は非公開またはワークスペース公開のときに使えます。公開サイトに `--allow-email` は指定できません。

`--wait` を付けると、公開範囲が実際に切り替わるまで待機します。反映には 40〜60 秒かかることがあります。

```sh
npx @hayatosc/sites access set --public --wait --timeout 120
```

## カスタムドメイン

```sh
npx @hayatosc/sites domains add example.com
npx @hayatosc/sites domains list
npx @hayatosc/sites domains refresh example.com
npx @hayatosc/sites domains remove example.com
```

`domains add` は必要な DNS レコードを表示します。DNS の設定は自動化しません。設定後に `refresh` を実行すると検証状態を更新します。`--wait` を付けると、状態が `active` になるまでポーリングします。

カスタムドメインでは、HTTPS 証明書の発行に時間がかかることがあります。

## アクセス解析

```sh
npx @hayatosc/sites analytics summary
npx @hayatosc/sites analytics summary --since 7d --view classic
npx @hayatosc/sites analytics events --since 24h
```

`--since` は `30m`、`24h`、`7d` のような形式です。集計は 1 時間単位で、UTC-08:00 の境界に合わせて丸められます。最新のデータが反映されるまで最大 1 時間かかることがあります。

`--view` は `classic` または `list` を指定します。イベント一覧では、リクエストトラフィックのビューが `null` になることがあります。

## 診断

```sh
npx @hayatosc/sites doctor
npx @hayatosc/sites doctor --offline
npx @hayatosc/sites doctor --fix-git
npx @hayatosc/sites doctor --verbose
```

`doctor` は次の項目を確認します。

- Node.js のバージョン
- 認証ファイルの有無とトークンの期限
- MCP への接続と `plugin-runtime` の応答
- `hosting.json` のキー
- `project_id` と API のサイト情報の一致
- 未対応の wrangler 機能
- `dist` とマニフェストの整合性
- Git の未コミット変更、リモートとの分岐
- Git コマンドの有無
- `package.json` のビルドスクリプト
- 直近のレート制限
- 状態ファイルと実際のデプロイの一致

`--offline` はネットワークを使う確認をスキップします。`--fix-git` は `.gitignore` の不足分を追加し、必要なら Git リポジトリを初期化します。`--verbose` は各項目の詳細を表示します。

問題がなければ終了コード 0、失敗があれば 1 です。警告だけの場合は 0 です。

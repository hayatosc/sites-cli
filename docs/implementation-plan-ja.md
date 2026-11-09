# sites CLI 実装方針：依存と配布

この文書は配布とバンドラーの方針を規定する。CLI の操作仕様は [ユーザーマニュアル](index.md) を参照する。

## オーナー決定（2026-11-09）

2026-11-07 の「Rolldown を同梱する」という決定は撤回する。Rolldown のネイティブバインディング（`.node`）を単一の `.mjs` に含めるための特別な仕組みは実装しない。配布は npm パッケージ `@hayatosc/sites` を前提とする。

| 依存 | 配布方法 | 用途 |
|---|---|---|
| `rolldown` | 通常の npm 実行時依存。`dist/cli.mjs` では外部 import として残す | Worker を単一 ESM にバンドルする |
| `gunshi` | JavaScript を `dist/cli.mjs` に同梱する。外部 import として残さない | コマンド定義、引数解析、実行、ヘルプ |
| `tinyexec` | JavaScript を `dist/cli.mjs` に同梱する。外部 import として残さない | 子プロセス起動 |

- `package.json` の `dependencies` は `rolldown`、`tinyexec`、`gunshi` とする。Gunshi の追加は CLI 基盤移行のオーナー指示による。
- npm の通常の依存インストールで、Rolldown と対応するプラットフォーム用バインディングを解決する。利用者の Worker プロジェクトに Rolldown を追加する必要はない。
- `src/bundler.ts` は `import { build } from "rolldown"` を使う。独自のネイティブパス解決、遅延 import、ネイティブパスの明示指定は行わない。
- `vite.config.ts` は `deps.neverBundle: ["rolldown"]` と `deps.alwaysBundle: ["tinyexec", "gunshi"]` を指定する。CLI 自身の JavaScript は単一の `dist/cli.mjs` に生成する。
- 成果物の外部 import は Node 組み込みモジュールと `rolldown` に限定する。成果物だけを取り出した完全スタンドアロン配布は仕様としない。

## 検証条件

- `nlx vp check`、`nlx vp test`、`nlx vp pack` が成功すること。
- 成果物の import 一覧に `gunshi`、`tinyexec` や他の外部パッケージが残らないこと。
- 通常の npm 依存を利用できる環境で、built CLI が小さな Worker をバンドルできること。`NAPI_RS_NATIVE_LIBRARY_PATH` などのネイティブパス指定は不要であること。
- 検証はローカルのファイルとモックだけで行い、実サービスへのデプロイは行わない。

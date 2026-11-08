# Configuration

## .openai/hosting.json

Site configuration lives in `.openai/hosting.json`. `init` creates a minimal file and `create` writes `project_id` into it.

```json
{
  "project_id": "appgprj_xxx",
  "static": {
    "directory": "dist",
    "not_found_handling": "404-page"
  }
}
```

| Key                           | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| `project_id`                  | Sites project ID, or `null` before creation              |
| `static`                      | Static site settings; omit for a Worker-only site        |
| `static.directory`            | Build output directory, sent to the API as `dist`        |
| `static.not_found_handling`   | `none`, `404-page`, or `single-page-application`         |
| `d1`                          | D1 binding name, for example `"DB"`                      |
| `r2`                          | R2 binding name, for example `"BUCKET"`                  |
| `capabilities`                | Additional capabilities; currently only `["mcp"]`        |

`plugins` and `connectors` are reserved. Keys that the API does not accept cause the deployment to fail.

## Static sites

Put static output in `static.directory`. `dist/index.html` is required. The manifest sent to the API rewrites `directory` to `dist`.

`not_found_handling` accepts:

- `none`: return a plain 404.
- `404-page`: serve `404.html`.
- `single-page-application`: fall back to `index.html` for all paths.

## Worker sites

A Worker is deployed as a single ESM file at `dist/server/index.js` and must have a default export.

- Only `cloudflare:*` and `node:*` imports are allowed.
- Relative imports, `require()`, and file reads through `import.meta.url` are rejected.
- `.wasm` and binary imports are rejected.
- When `assets.directory` is present, static files are placed in `dist/client`.

A static site cannot be combined with `d1`, `r2`, or `capabilities`. Adding runtime bindings to a static site is rejected at deploy time.

## D1

Set `d1` to a binding name to apply migrations from `drizzle/` during deployment. Migrations are included in `dist/.openai/drizzle/` and run before the Worker starts.

- Files are applied in lexicographic order. Zero-pad names such as `0001_init.sql`.
- Applied migrations are tracked in `__appgarden_migrations`.
- Multiple D1 bindings are not supported.

## R2

Set `r2` to a binding name to expose an R2 bucket to the Worker. Multiple R2 bindings are not supported.

## Environment variables

`deploy --env-file` reads a file of `KEY=VALUE` entries and stores them as non-secret Sites environment variables. `deploy --secrets-file` accepts dotenv or JSON and stores entries as secrets. Changes take effect on the next deployment.

```sh
npx @hayatosc/sites deploy --env-file .env.production
npx @hayatosc/sites deploy --secrets-file .env.secrets
```

Secret files expand `$VAR` and `${VAR}` from the process environment and earlier entries. Process environment values override file values, even when empty. Set individual secrets with `sites env set KEY=VALUE --secret`; secret values cannot be read back from the API.

## Converting from wrangler

When `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` is present, `deploy` converts it to `.openai/hosting.json`. The CLI looks for files in this order:

1. `wrangler.jsonc`
2. `wrangler.json`
3. `wrangler.toml`

The main conversions are:

| wrangler                    | hosting.json                         |
| --------------------------- | ------------------------------------ |
| `name`                      | Candidate slug and title             |
| `main`                      | Bundled to `dist/server/index.js`    |
| `assets.directory`          | `dist/client`                        |
| `assets.not_found_handling` | `static.not_found_handling`          |
| `d1_databases[0].binding`   | `d1`                                 |
| `r2_buckets[0].binding`     | `r2`                                 |
| `migrations_dir`            | `dist/.openai/drizzle`               |

`vars`, crons, routes, and compatibility flags are reported as warnings. Set `vars` separately as environment variables before deploying.

## Unsupported features

The following features cannot be converted automatically. If one is detected, the CLI writes nothing and stops.

- KV, Durable Objects, Queues, Services, Hyperdrive, and Vectorize
- Workers AI and Browser Rendering
- `[[rules]]`
- `.wasm` imports
- More than one D1 or R2 binding
- Workers that violate the single-ESM constraints

Use `--allow-unsupported` to continue intentionally with a listed kind. The conversion report still records the unconverted feature.

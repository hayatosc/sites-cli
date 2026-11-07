# sites manual

`sites` is a command-line client for creating, deploying, and operating ChatGPT Sites. It uses the Codex CLI credentials, so there is no separate login flow.

## Install and run

Node.js 22.13 or newer is required. Use `npx` to run the CLI without installing it.

```sh
npx @hayatosc/sites --help
npx @hayatosc/sites auth whoami
```

To pin a version, add the package to your project.

```sh
ni -D @hayatosc/sites
npx sites --version
```

## Authentication

The access token is resolved in this order:

1. The `SITES_ACCESS_TOKEN` environment variable.
2. `tokens.access_token` in `~/.codex/auth.json`.

If the token in `~/.codex/auth.json` has expired, the CLI refreshes it and writes the rotated token back to the same file with mode `0600`. It never creates a separate login or token store.

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check
```

`--check` connects to the MCP server and verifies both authentication and connectivity.

## First deployment

```sh
mkdir my-site && cd my-site
npx @hayatosc/sites init --template static
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`init` creates `.openai/hosting.json` and a build scaffold. `create` creates the site and stores the returned `project_id` in the manifest. `deploy` builds the project, syncs source, uploads the archive, and deploys it.

## Output

The default output is JSON, which is suitable for scripts and agents.

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

Use `--human` for human-readable output. Progress, warnings, and diagnostics go to stderr; `--quiet` suppresses progress. Errors return `ok: false` plus `error.code`, `error.message`, and `error.hint`.

## Exit codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Success                                      |
| 1    | General error or failed deployment           |
| 2    | Invalid arguments                            |
| 3    | Authentication error                         |
| 4    | Network error or timeout                     |
| 5    | Preflight failure                            |
| 6    | Conflict (slug taken, source changed, etc.)  |
| 130  | Interrupted (SIGINT)                         |

## Searching the manual

`sites docs search` searches the manual bundled into the CLI. It does not read a `docs/` directory or use the network.

```sh
npx @hayatosc/sites docs search "custom domain"
npx @hayatosc/sites docs search "dry-run"
```

Use `sites cli search` to find commands by task.

```sh
npx @hayatosc/sites cli search "environment variables"
```

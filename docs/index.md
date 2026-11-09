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

`whoami` follows the `cf` CLI shape: it reports `authenticated`, `authSource`, `tokenValid`, `accountId`, `expiresAt`, and `refreshTokenPresent`. Without credentials it still succeeds with `authenticated: false` and `error: "Not logged in"`, so scripts can branch on the result. `--check` is the exception: it needs valid credentials because it contacts MCP.

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

The default output is bare pretty-printed JSON, matching cf. Errors are human-readable on stderr and exit 1; interruption exits 130. Delegated `dev`/build subprocesses preserve their exit status. Search results are bare arrays and schema results are tool objects.

Use `--json` to retain the previous envelope and detailed error codes:

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

Use `--human` for human-readable output. Progress, warnings, and diagnostics go to stderr; success labels appear only on a TTY. `--quiet` suppresses results and progress (not errors), and `--quiet=false` restores output. With explicit `--json`, errors return `ok: false` plus `error.code`, `error.message`, and `error.hint`.

Every command supports `--dry-run`: most only preview parsed arguments without auth, network or file effects. Native deploy/version previews may build locally; migrate stages output in a temporary directory; create/env push inspect local inputs. Preview results omit sensitive argument values.

## Exit codes

Default mode uses 0, 1 and 130, like cf. Explicit `--json` retains these detailed codes:

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

`sites docs search` searches the manual bundled into the CLI. It does not read a `docs/` directory or use the network. It returns up to five `{title, description, url, file, line}` results; `url` points at the matching section of the GitHub-hosted manual.

```sh
npx @hayatosc/sites docs search "custom domain"
npx @hayatosc/sites docs search "dry-run"
```

Use `sites cli search` to find commands by task. It returns up to five `{command, summary}` results, ranked by dependency-free weighted substring matching, exact-command priority, and limited typo correction. Rankings are not identical to `cf cli search`. Keep queries anonymous: describe the action and resource type, not names, domains, IDs, or tokens.

```sh
npx @hayatosc/sites cli search "environment variables"
```

Both searches are advertised in `--help` when the CLI detects an agent harness. After choosing a command, run `sites <command> --help` for its flags. `sites schema --list` lists MCP tools, and `sites schema <tool>` prints one tool's input schema; `sites schema versions create` maps a CLI path to its underlying MCP schemas.

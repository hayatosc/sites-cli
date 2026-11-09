# @hayatosc/sites

[![npm version](https://img.shields.io/npm/v/@hayatosc/sites.svg)](https://www.npmjs.com/package/@hayatosc/sites)
[![Node.js](https://img.shields.io/node/v/@hayatosc/sites.svg)](https://nodejs.org)
[![GitHub](https://img.shields.io/badge/github-hayatosc%2Fsites--cli-181717?logo=github)](https://github.com/hayatosc/sites-cli)

Deploy ChatGPT Sites projects from the command line.

`sites` creates, deploys, and operates ChatGPT Sites using shared Codex CLI credentials. There is no separate login or token store.

Requires **Node.js 22.13** or newer.

## Install

```sh
# one-off
npx @hayatosc/sites --help

# or install globally
npm install -g @hayatosc/sites
sites --help
```

pnpm and bun work the same way (`pnpm dlx`, `bunx`).

The published package keeps [Rolldown](https://rolldown.rs) as a normal runtime dependency (including its platform-specific native binding). Gunshi and tinyexec are bundled into `dist/cli.mjs`. Run the CLI with the package's installed dependencies; Worker projects do not need their own Rolldown install.

## Quick start

Use an existing application project. Prepare `.openai/hosting.json` (static example):

```json
{
  "project_id": null,
  "static": { "directory": "dist" }
}
```

```sh
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`create` creates the remote site and writes `project_id` into the manifest. `deploy` builds, syncs source, uploads the archive, and deploys. Scaffolding, local development, and type generation stay with your project's own tools. Worker manifests and Wrangler conversion are covered in the [configuration manual](docs/configuration.md).

## Authentication

Credentials are resolved in this order:

1. `SITES_ACCESS_TOKEN` (if set)
2. `tokens.access_token` in `~/.codex/auth.json` (Codex CLI)

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check   # connect to MCP and verify
```

`auth whoami` reports `authenticated`, `authSource`, `tokenValid`, `accountId`, `expiresAt`, and `refreshTokenPresent`. Without credentials it succeeds with `authenticated: false` so scripts can inspect the result; `--check` requires working credentials.

## Commands

| Command | Description |
| --- | --- |
| `sites create <slug>` | Create a site and save `project_id` |
| `sites list` | List sites |
| `sites info [project\|slug]` | Show site details |
| `sites complete [shell]` | Print shell completion setup |
| `sites deploy` | Build and deploy (`--prebuilt` skips the build) |
| `sites status [deployment_id]` | Show deployment status (`--watch` to wait) |
| `sites logs` | Fetch Worker logs (`--follow` to stream) |
| `sites versions create\|list\|get\|show\|rollback` | Manage versions |
| `sites env list\|get\|set\|unset\|pull\|push` | Manage environment variables |
| `sites access show\|set` | Manage access mode |
| `sites domains add\|get\|list\|refresh\|remove` | Manage custom domains |
| `sites analytics summary\|events` | Read analytics |
| `sites open` | Open in a browser (`--print` for the URL only) |
| `sites delete --force` | Delete a site |
| `sites doctor` | Diagnose the local environment and connection |
| `sites auth whoami [--check]` | Show identity status |
| `sites cli search <query>` | Rank up to five commands by intent |
| `sites docs search <query>` | Search the bundled manual |
| `sites schema <tool\|command..>` / `sites schema --list` | Print MCP tool input schemas |

Run `sites <command> --help` for command-specific flags. Agents should prefer `sites cli search` and `sites docs search` over chaining nested `--help` calls.

### Manual

- [Projects](docs/projects.md) — setup, creation, listing, deletion, completion
- [Deployment](docs/deploy.md) — build, source sync, upload, status, logs
- [Operations](docs/operations.md) — versions, env, access, domains, analytics, doctor
- [Configuration](docs/configuration.md) — `hosting.json`, bindings, Wrangler conversion
- [Reference](docs/reference.md) — flags, environment variables, output shapes

## Output and exit codes

Success data is bare JSON on stdout. Errors are human-readable on stderr. Search results are bare arrays. `logs --follow` streams NDJSON (human lines with `--human`).

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Any failure (including a failed deployment build) |
| 130 | Interrupted or declined confirmation |

`--quiet` / `-q` suppresses results and progress, not errors (`--quiet=false` restores output). `--human` prints human-readable tables/text. There is no `--json` envelope mode and no `--yes`/`-y`; use `--force` (`-f`) where confirmation must be skipped.

Every command accepts `--dry-run`. Most commands preview parsed arguments only (no auth, network, or filesystem side effects). Deploy and version creation may still build locally; create and env push validate local inputs.

## Configuration and environment

Site settings live in `.openai/hosting.json`. Common keys: `project_id`, `static.directory`, `static.not_found_handling`, `d1`, `r2`, `capabilities`. See [Configuration](docs/configuration.md).

| Variable | Description |
| --- | --- |
| `SITES_ACCESS_TOKEN` | Access token (overrides Codex auth file) |
| `SITES_AUTH_PATH` | Path to the Codex auth file |
| `SITES_AUTH_URL` | Token refresh endpoint |
| `SITES_MCP_URL` | MCP server URL |
| `SITES_API_BASE` | File API base URL |
| `SITES_RETRY_BASE_MS` | Base delay for rate-limit retries |
| `SITES_UPLOAD_POLL_MS` | Upload completion polling interval |
| `SITES_LOG_INTERVAL_MS` | `logs --follow` polling interval |
| `NO_COLOR` | Disable color |

Normal usage does not require any of these variables.

When `.openai/hosting.json` is absent and a Wrangler config is present, `deploy` can convert `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` and bundle the Worker with Rolldown. Unsupported bindings stop the conversion unless you pass `--allow-unsupported <kind>`.

## Examples

```sh
# Deploy with a message; skip confirmation when making a site public
npx @hayatosc/sites deploy --message "Update pricing" --public --force

# Deploy an already-built dist/
npx @hayatosc/sites deploy --prebuilt --allow-dirty

# Apply env and secrets during deploy
npx @hayatosc/sites deploy --env-file .env.production --secrets-file .env.secrets

# Watch a deployment finish
npx @hayatosc/sites status --watch

# Roll back to the previous successful version
npx @hayatosc/sites versions rollback --previous --force

# Find a command or a manual section
npx @hayatosc/sites cli search "custom domain"
npx @hayatosc/sites docs search "not_found_handling"
```

## Development

```sh
npm install
npm run typecheck   # vp check
npm test            # vp test
npm run build       # vp pack → dist/cli.mjs
```

Build, test, lint, formatting, and type checking use [Vite+](https://viteplus.dev) (`vp`). The user manual in `docs/` is embedded into the CLI at build time, so `sites docs search` does not need a local `docs/` directory after install.

`dist/` is produced by the build and is gitignored; `prepack` rebuilds before `npm pack` / publish.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

License is not declared yet. See open questions before redistributing.

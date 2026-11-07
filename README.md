# @hayatosc/sites

Command-line client for ChatGPT Sites. Requires Node.js 22.13 or newer.

```sh
npx @hayatosc/sites --help
```

## Authentication

The CLI reuses the Codex CLI credentials in `~/.codex/auth.json`. If `SITES_ACCESS_TOKEN` is set, that token takes precedence. There is no separate login or token store.

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check   # connect to MCP and verify
```

`auth whoami` reports `authenticated`, `authSource`, `tokenValid`, `accountId`, `expiresAt`, and `refreshTokenPresent`. Like `cf auth whoami`, an unauthenticated invocation succeeds with `authenticated: false` so scripts can inspect the result; `--check` still requires working credentials.

## Getting started

```sh
mkdir my-site && cd my-site
npx @hayatosc/sites init --template static
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`init` creates `.openai/hosting.json` and a build scaffold. `create` creates the site and stores the returned `project_id` in the manifest. `deploy` builds the project, syncs source, uploads the archive, and deploys it.

## Commands

| Command                                          | Description                                    |
| ------------------------------------------------ | ---------------------------------------------- |
| `sites init [dir] --template static\|worker-esm` | Create a project scaffold                      |
| `sites create <slug>`                            | Create a site and save `project_id`            |
| `sites list`                                     | List sites                                     |
| `sites info [project\|slug]`                     | Show site details                              |
| `sites deploy`                                   | Build and deploy                               |
| `sites status [deployment_id]`                   | Show deployment status (`--watch` to wait)     |
| `sites logs`                                     | Fetch Worker logs (`--follow` to stream)       |
| `sites versions list\|show\|rollback`            | List, inspect, and roll back versions          |
| `sites env list\|get\|set\|unset\|pull\|push`    | Manage environment variables                   |
| `sites access show\|set`                         | Manage access mode                             |
| `sites domains add\|list\|refresh\|remove`       | Manage custom domains                          |
| `sites analytics summary\|events`                | Read analytics                                 |
| `sites open`                                     | Open in a browser (`--print` for the URL only) |
| `sites delete --yes`                             | Delete a site                                  |
| `sites doctor`                                   | Diagnose the local environment and connection  |
| `sites cli search <query>`                       | Rank up to five commands by intent             |
| `sites docs search <query>`                      | Search the bundled manual                      |
| `sites schema <tool>` / `sites schema --list`    | Print MCP tool input schemas                   |

Run `sites <command> --help` for command-specific flags.

## Output and exit codes

The default output is JSON. `--human` produces human-readable output. Progress and warnings go to stderr and can be suppressed with `--quiet` (or re-enabled with `--quiet=false`). Search and schema results place their arrays and objects directly in `data`, matching the shape of the equivalent `cf` commands.

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 0    | Success                                     |
| 1    | General error or failed deployment          |
| 2    | Invalid arguments                           |
| 3    | Authentication error                        |
| 4    | Network error or timeout                    |
| 5    | Preflight failure                           |
| 6    | Conflict (slug taken, source changed, etc.) |
| 130  | Interrupted                                 |

## Converting from wrangler

When `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` is present, `deploy` converts it to `.openai/hosting.json` and bundles the Worker with Rolldown. If an unsupported binding is present, the command stops without writing files. Use `--allow-unsupported <kind>` to continue intentionally.

## Development

```sh
ni
nlx vp check
nlx vp test
nlx vp pack
```

`dist/cli.mjs` is the executable. Build, test, lint, formatting, and type checking all use Vite+ (`vp`). The user manual lives in `docs/` and is embedded into the CLI at build time, so `sites docs search` does not need an external `docs/` directory. Help output includes a command-discovery block when an agent harness is detected; `sites cli search` and `sites docs search` are the intended entry points for agents.

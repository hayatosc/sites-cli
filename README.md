# @hayatosc/sites

Command-line client for ChatGPT Sites. Requires Node.js 22.13 or newer.

```sh
npx @hayatosc/sites --help
```

The npm package keeps Rolldown as a normal runtime dependency, including its platform-specific native binding. Only tinyexec is bundled into the CLI JavaScript. Run `dist/cli.mjs` with the package's installed dependencies; no native-library path override is needed, and the Worker project does not need its own Rolldown installation.

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

`init` scaffolds an empty directory or configures an existing project without replacing its sources or package scripts. `create` creates the site and stores the returned `project_id` in `.openai/hosting.json`. `deploy` builds the project, syncs source, uploads the archive, and deploys it.

## Commands

| Command                                                  | Description                                    |
| -------------------------------------------------------- | ---------------------------------------------- |
| `sites init [dir] --template static\|worker-esm`         | Create a project scaffold                      |
| `sites create <slug>`                                    | Create a site and save `project_id`            |
| `sites list`                                             | List sites                                     |
| `sites info [project\|slug]`                             | Show site details                              |
| `sites build`                                            | Build and validate locally without deploying   |
| `sites dev [-- <args..>]`                                | Run the project's dev script                   |
| `sites migrate [path]`                                   | Convert Wrangler config (`--dry-run` to plan)  |
| `sites complete [shell]`                                 | Print shell completion setup                   |
| `sites migrations create <message>`                      | Scaffold local SQL in `drizzle/`               |
| `sites types`                                            | Generate manifest D1/R2 binding declarations   |
| `sites deploy`                                           | Build and deploy (`--prebuilt` to skip build)  |
| `sites status [deployment_id]`                           | Show deployment status (`--watch` to wait)     |
| `sites logs`                                             | Fetch Worker logs (`--follow` to stream)       |
| `sites versions create\|list\|get\|show\|rollback`       | List, inspect, and roll back versions          |
| `sites env list\|get\|set\|unset\|pull\|push`            | Manage environment variables                   |
| `sites access show\|set`                                 | Manage access mode                             |
| `sites domains add\|get\|list\|refresh\|remove`          | Manage custom domains                          |
| `sites analytics summary\|events`                        | Read analytics                                 |
| `sites open`                                             | Open in a browser (`--print` for the URL only) |
| `sites delete --force`                                   | Delete a site                                  |
| `sites doctor`                                           | Diagnose the local environment and connection  |
| `sites cli search <query>`                               | Rank up to five commands by intent             |
| `sites docs search <query>`                              | Search the bundled manual                      |
| `sites schema <tool\|command..>` / `sites schema --list` | Print MCP tool input schemas                   |

Run `sites <command> --help` for command-specific flags.

## Output and exit codes

Like cf, the default is bare JSON on stdout, with human-readable errors on stderr and exit 1 on failure (130 on interruption; delegated `dev`/build commands preserve subprocess exit status). `--quiet` suppresses results and progress, but not errors; `--quiet=false` re-enables output. Success labels appear only on interactive stderr. `--human` is a human-readable extension.

**Compatibility:** scripts expecting the previous `{ok,data,meta}` envelope must now pass `--json`. This explicit mode also retains structured errors and the detailed exit codes below. Search results are bare arrays by default, or `data` arrays with `--json`. `logs --follow` streams NDJSON (human lines with `--human`) rather than a final envelope.

Every command accepts `--dry-run`. Most preview parsed arguments only, without auth, network, files or argument values. Deploy/version creation may build locally; migrate stages its conversion; create/env push validate local inputs.

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

Use `sites migrate [directory-or-config-file] --dry-run` to inspect conversion first. Applying requires a clean Git worktree unless `--force`; replacing a manifest also requires `--force` and retains its linked `project_id`.

When `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` is present, `deploy` converts it to `.openai/hosting.json` and bundles the Worker with Rolldown. If an unsupported binding is present, the command stops without writing files. Use `--allow-unsupported <kind>` to continue intentionally.

For other projects, `deploy` detects the framework, package manager, build command, and output directory using cf-compatible rules. Static output directories such as `dist`, `build`, `out`, `public`, and `.output/public` are normalized to `dist/`; worker output is rebundled to `dist/server/index.js`.

## Development

```sh
ni
nlx vp check
nlx vp test
nlx vp pack
```

`dist/cli.mjs` is the executable. Build, test, lint, formatting, and type checking all use Vite+ (`vp`). The user manual lives in `docs/` and is embedded into the CLI at build time, so `sites docs search` does not need an external `docs/` directory. Help output includes a command-discovery block when an agent harness is detected; `sites cli search` and `sites docs search` are the intended entry points for agents.

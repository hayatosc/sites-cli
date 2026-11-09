# Reference

## Global flags

Global flags may appear before, within or after a command path.

| Flag               | Description                     |
| ------------------ | ------------------------------- |
| `--json`           | Opt in to legacy JSON envelope and detailed exit codes           |
| `--human`          | Human-readable output           |
| `-q`, `--quiet`    | Suppress results and progress, not errors (`--quiet=false` re-enables) |
| `--profile <name>` | Reserved; rejected (authentication is owned by Codex)                  |
| `--no-color`       | Disable color                   |
| `-y`, `--yes`      | Skip confirmation               |
| `--dry-run`        | Preview without remote side effects (native builds may write locally) |
| `-h`, `--help`     | Show help                       |
| `-v`, `--version`  | Show the version                |

Bare JSON is the default; errors use human-readable stderr and exit 1 (130 on interruption). Delegated `dev`/build subprocesses retain their own exit status (also during deploy/version creation). `--json` restores `{ok,data,meta}` and structured errors. `--human` is an extension; it cannot be combined with `--json`. `logs --follow` streams NDJSON, not an envelope. Color is disabled when `NO_COLOR` is set.

Cloudflare-only `--zone/-z`, `--mode/-m`, `--local`, `--persist-to`, `--temporary-account` and `--event-code` are explicitly rejected; temporary-account event secrets are never printed or forwarded.

Generic dry-run validates parsing only and omits values. Deploy/version previews may build locally, migrate stages conversion, and create/env push validate local inputs. Boolean flags accept `=true`/`=false`, space-separated `true`/`false`, and negation. For example, `sites --quiet false cli search deploy` prints results. The last boolean setting wins; `--json false` and `--json=false` both restore default output/error behavior even for parsing errors. `--` ends option parsing. Missing, empty or duplicate singleton string flags are errors.

## Commands

| Command                                              | Description                              |
| ---------------------------------------------------- | ---------------------------------------- |
| `auth whoami [--check]`                              | Show cf-style identity status            |
| `init [dir] --template static\|worker-esm`           | Create a project scaffold                |
| `create <slug>`                                      | Create a site and save its ID            |
| `list`                                               | List sites                               |
| `info [project\|slug]`                               | Show site details                        |
| `build`                                              | Build and validate locally without deploying |
| `dev [-- <args..>]`                                  | Run the package dev script, no Sites runtime emulation |
| `migrate [path]`                                     | Convert a Wrangler directory or config file |
| `complete [bash\|zsh\|fish\|powershell]`           | Print completion setup (does not edit shell rc files); `complete -- <words..>` handles flags/values in command paths |
| `migrations create <message>`                       | Scaffold local SQL (`--dir drizzle`, optional `--pattern`) |
| `types`                                             | Generate binding declarations (`--out .openai/types.d.ts`, `--force`) |
| `deploy`                                             | Build and deploy                         |
| `status [deployment_id]`                             | Show deployment status                   |
| `logs`                                               | Fetch Worker logs                        |
| `versions create`                                    | Upload a version without activating it |
| `versions list`                                      | List versions                            |
| `versions get\|show <version_id>`                         | Show a version                           |
| `versions rollback <version_id\|--previous>`         | Redeploy a previous version              |
| `env list`                                           | List environment variables               |
| `env get <key>`                                      | Get an environment variable              |
| `env set <KEY>=<VALUE>`                              | Set an environment variable              |
| `env unset <key>`                                    | Remove an environment variable           |
| `env pull`                                           | Write environment variables locally      |
| `env push`                                           | Apply local environment variables        |
| `access show`                                        | Show access mode                         |
| `access set`                                         | Change access mode                       |
| `domains add <hostname>`                             | Add a custom domain                      |
| `domains get <hostname\|id>`                        | Get domain status and DNS instructions |
| `domains list`                                       | List custom domains                      |
| `domains refresh <hostname\|id>`                     | Refresh domain status                    |
| `domains remove <hostname\|id>`                      | Remove a custom domain                   |
| `analytics summary`                                  | Show analytics summary                   |
| `analytics events`                                   | List analytics events                    |
| `open [project\|slug]`                               | Open the site in a browser               |
| `delete [project\|slug]`                             | Delete a site                            |
| `doctor`                                             | Diagnose the environment and connection  |
| `cli search <query>`                                 | Rank up to five commands by intent       |
| `docs search <query>`                                | Search this manual                       |
| `schema <tool\|command..>`                          | Print MCP tool input schemas           |
| `schema --list`                                      | List MCP tools and descriptions          |

Run `sites <command> --help` for the flags of a command.

## Environment variables

| Variable                   | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `SITES_ACCESS_TOKEN`       | Access token to use                              |
| `SITES_AUTH_PATH`          | Path to the Codex auth file                      |
| `SITES_AUTH_URL`           | Token refresh endpoint                           |
| `SITES_MCP_URL`            | MCP server URL                                   |
| `SITES_API_BASE`           | File API base URL                                |
| `SITES_RETRY_BASE_MS`      | Base delay for rate-limit retries                |
| `SITES_UPLOAD_POLL_MS`     | Upload completion polling interval               |
| `SITES_LOG_INTERVAL_MS`    | `logs --follow` polling interval                 |
| `SITES_ALLOW_INSECURE_GIT` | Allow `file://` remotes when set to `1` (tests)  |
| `NO_COLOR`                 | Disable color                                    |

Normal usage does not require any of these variables.

## Search and schema output

`cli search` returns up to five `{command, summary}` objects. Commands include the `sites` prefix, so a result can be run as printed. Ranking uses dependency-free weighted substring matching (command/summary/description/keywords/context weights 8/5/2/5/0.5), exact-command priority, and limited edit-distance correction for words of at least five characters. Rankings can differ from the `cf` CLI; this is not semantic or translated search.

`docs search` returns up to five `{title, description, url, file, line}` objects. `url` points at the matching section in the GitHub-hosted manual; searches run entirely against the manual bundled into the CLI.

`schema <tool>` or `schema <command..>` returns the MCP tool's `{name, description, inputSchema}` object. `schema --list` returns `{name, description}` entries. An unknown or missing tool name is an error, as in `cf schema`. Multi-tool commands return multiple schemas. The hidden `tools` alias is equivalent to `schema --list`; hidden aliases are excluded from search and completion.

## State file

`.sites/state.json` is managed by the CLI and should not be edited. Tags created by `deploy --tag` or `versions create --tag` are stored there. Uploaded version/SHA/hash fields are separate from the last successful deployment, so saving a version does not claim to activate it.

## Auth file

`~/.codex/auth.json` is shared with the Codex CLI. `sites` modifies it only when:

- The access token has expired and a refresh token is available.
- A 401 response requires a forced refresh.

Writes use a temporary file and rename, and the result is mode `0600`. The `auth_mode`, `OPENAI_API_KEY`, and `tokens.account_id` fields are preserved.

`auth whoami` follows `cf auth whoami`: it reports `authenticated`, `authSource`, `tokenValid`, `accountId`, `expiresAt`, and `refreshTokenPresent`. Without credentials it succeeds with `authenticated: false` and `error: "Not logged in"`; `--check` requires working credentials because it connects to MCP.

# Reference

## Global flags

Global flags may appear before or after a command.

| Flag               | Description                     |
| ------------------ | ------------------------------- |
| `--json`           | JSON output (default)           |
| `--human`          | Human-readable output           |
| `-q`, `--quiet`    | Suppress progress output        |
| `--profile <name>` | Profile to use                  |
| `--no-color`       | Disable color                   |
| `-y`, `--yes`      | Skip confirmation               |
| `-h`, `--help`     | Show help                       |
| `-v`, `--version`  | Show the version                |

Color is also disabled when `NO_COLOR` is set.

## Commands

| Command                                              | Description                              |
| ---------------------------------------------------- | ---------------------------------------- |
| `auth whoami [--check]`                              | Show identity and check connectivity     |
| `init [dir] --template static\|worker-esm`           | Create a project scaffold                |
| `create <slug>`                                      | Create a site and save its ID            |
| `list`                                               | List sites                               |
| `info [project\|slug]`                               | Show site details                        |
| `deploy`                                             | Build and deploy                         |
| `status [deployment_id]`                             | Show deployment status                   |
| `logs`                                               | Fetch Worker logs                        |
| `versions list`                                      | List versions                            |
| `versions show <version_id>`                         | Show a version                           |
| `versions rollback <version_id\|--previous>`         | Redeploy a previous version              |
| `env list`                                           | List environment variables               |
| `env get <key>`                                      | Get an environment variable              |
| `env set <key> <value>`                              | Set an environment variable              |
| `env unset <key>`                                    | Remove an environment variable           |
| `env pull`                                           | Write environment variables locally      |
| `env push`                                           | Apply local environment variables        |
| `access show`                                        | Show access mode                         |
| `access set`                                         | Change access mode                       |
| `domains add <hostname>`                             | Add a custom domain                      |
| `domains list`                                       | List custom domains                      |
| `domains refresh <hostname\|id>`                     | Refresh domain status                    |
| `domains remove <hostname\|id>`                      | Remove a custom domain                   |
| `analytics summary`                                  | Show analytics summary                   |
| `analytics events`                                   | List analytics events                    |
| `open [project\|slug]`                               | Open the site in a browser               |
| `delete [project\|slug]`                             | Delete a site                            |
| `doctor`                                             | Diagnose the environment and connection  |
| `cli search <query>`                                 | Search commands                          |
| `docs search <query>`                                | Search this manual                       |
| `schema [tool]`                                      | Print MCP tool input schemas             |

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

## State file

`.sites/state.json` is managed by the CLI and should not be edited. Tags created by `deploy --tag` are stored there.

## Auth file

`~/.codex/auth.json` is shared with the Codex CLI. `sites` modifies it only when:

- The access token has expired and a refresh token is available.
- A 401 response requires a forced refresh.

Writes use a temporary file and rename, and the result is mode `0600`. The `auth_mode`, `OPENAI_API_KEY`, and `tokens.account_id` fields are preserved.

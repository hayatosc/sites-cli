# sites CLI manual

`sites` creates, deploys, and operates ChatGPT Sites using the Codex CLI credentials. There is no separate login flow.

## Install and run

Node.js 22.13 or newer is required.

```sh
npx @hayatosc/sites --help
```

You can also install the package globally and run `sites` directly.

## Authentication

Credentials are read in this order:

1. `SITES_ACCESS_TOKEN`.
2. `tokens.access_token` in `~/.codex/auth.json`.

Network commands refresh an expired Codex token when a refresh token is available, and atomically write rotated credentials with mode `0600`. Normal `whoami` only reports identity and expiry; it does not refresh. Environment tokens cannot be refreshed. The CLI never creates a separate token store.

```sh
npx @hayatosc/sites auth whoami
npx @hayatosc/sites auth whoami --check
```

`whoami` reports `authenticated`, `authSource`, `tokenValid`, `accountId`, `expiresAt`, and `refreshTokenPresent`. Without credentials it succeeds with `authenticated: false` and `error: "Not logged in"`. `--check` requires valid credentials and verifies the MCP connection.

## First deployment

```sh
mkdir my-site && cd my-site
npx @hayatosc/sites init --template static
npx @hayatosc/sites create my-site
npx @hayatosc/sites deploy
npx @hayatosc/sites open
```

`init` creates a manifest with `project_id: null` and a build scaffold. `create` creates the remote site and saves its ID. `deploy` builds, synchronizes source, uploads, and deploys.

## Output

Success data is pretty-printed bare JSON on stdout, without an envelope. Search results are arrays; schema results are tool objects or arrays. `open --print` writes only a URL. `logs --follow` streams one JSON event per line (NDJSON).

Errors are human-readable on stderr, with optional `hint:` and `docs:` lines. Progress and warnings also use stderr; success labels require a TTY. `--quiet` suppresses results and progress, not errors or required confirmation. `--quiet=false` restores output. `NO_COLOR` and `--no-color` disable colors.

`--human` is an optional Sites extension for readable tables and text. There is no `--json` output mode, structured error JSON, or `{ok,data,meta}` envelope. Update older scripts to read the result directly.

Every command accepts `--dry-run`. Most only validate arguments without auth, network, or filesystem effects. Native deploy/version previews may build locally; migrate stages conversion; create and env push inspect local inputs. Previews omit sensitive argument values.

Destructive confirmation can only be bypassed with `--force` (`-f`) on commands that support it. `--yes` and `-y` are not supported. Quiet is not consent.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Failure, including usage, auth, network, preflight, conflict, and child-process failure |
| 130 | Interruption or declined confirmation |

Signals are forwarded and the CLI waits for child shutdown. Child exit values do not introduce additional CLI exit codes.

## Find commands and documentation

```sh
npx @hayatosc/sites cli search "deploy site"
npx @hayatosc/sites docs search "custom domain"
npx @hayatosc/sites schema deploy
```

Search works against bundled command definitions and documentation, without a local `docs/` directory or a remote search service. `schema` reads current MCP tool schemas and requires credentials. Run `sites <command> --help` for command-specific flags.

## Manual sections

- [Projects](projects.md): initialization, local workflows, creation, listing, and deletion.
- [Deployment](deploy.md): builds, source synchronization, uploads, status, and logs.
- [Operations](operations.md): versions, environment, access, domains, analytics, and diagnostics.
- [Configuration](configuration.md): manifest, runtime bindings, and Wrangler conversion.
- [Reference](reference.md): commands, flags, environment variables, and output.

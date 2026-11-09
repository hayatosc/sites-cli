# Deployment

## sites deploy

`deploy` performs the full workflow in one command:

1. Validate options and check uncommitted changes.
2. Convert Wrangler configuration if the manifest is absent, then read the linked manifest.
3. Detect/build or normalize output, then inspect the artifact and environment inputs. A native dry-run stops here.
4. Resolve authentication/site access and confirm a public access change if needed.
5. Synchronize source and create/upload the archive.
6. Save the version and uploaded metadata; apply environment changes.
7. Deploy, poll, update the desired audience, and save successful deployment state.

```sh
npx @hayatosc/sites deploy
npx @hayatosc/sites deploy --dry-run
npx @hayatosc/sites deploy --message "Update pricing page"
```

| Flag                          | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| `--dry-run`                   | Build and preflight only; no credentials, upload, or deployment |
| `--prebuilt`                  | Deploy existing `dist/` output without running the build      |
| `--no-build-script`           | Skip the project build command but still normalize output     |
| `--message <message>`         | Commit message for source synchronization                     |
| `--tag <tag>`                 | Store a local tag in the state file                           |
| `--private`                   | Make the site private after deployment                        |
| `--public`                    | Make the site public after deployment                         |
| `--workspace`                 | Make the site workspace-visible after deployment              |
| `--env-file <path>`           | Apply environment variables during deployment                 |
| `--secrets-file <path>`       | Apply secret variables from a JSON or dotenv file             |
| `--force`, `-f`               | Skip the public-deploy confirmation prompt                     |
| `--no-source-sync`            | Skip source synchronization                                   |
| `--allow-dirty`               | Continue even with uncommitted changes                        |
| `--allow-unsupported <kinds>` | Downgrade unsupported wrangler features to warnings (comma-separated) |
| `--timeout <seconds>`         | Deployment wait timeout (default 300)                         |

Only one access option may be specified. Changing a non-public site to public requires confirmation; use `--force` outside an interactive terminal.

## Source synchronization

`deploy` synchronizes project source to the Sites Git repository. Synchronization happens in a temporary checkout and never changes the history or remotes of your working repository.

- The latest remote commit is fetched before local files are overlaid.
- `.git`, `node_modules`, `dist`, `.sites`, and `outputs` are not synchronized.
- Credentials are passed as a one-off HTTP header and are never written to Git configuration.
- The remote commit is verified after the push to detect concurrent changes.

Uncommitted changes stop the command (exit 1) unless `--allow-dirty` is given, including prebuilt, dry-run and no-source-sync workflows. `--no-source-sync` skips synchronization and uses the existing HEAD or recorded uploaded/deployed commit; it does not require a recently dated commit.

## Environment and secrets

`deploy --env-file` stores non-secret variables. `deploy --secrets-file` stores secret variables and accepts either dotenv or a JSON object. Secret files expand `$VAR` and `${VAR}` references using process environment values and earlier entries; process environment values override file values, even when empty. Only keys declared in the file are uploaded.

```sh
npx @hayatosc/sites deploy --secrets-file .env.secrets
```

## Build

The external build's stdout/stderr stream immediately to stderr, never into the JSON result. Real terminal stdin/stderr are inherited, preserving framework TTY behavior; injected embedding streams are relayed. `--quiet` suppresses child progress. Child build failures exit 1; interruptions exit 130. SIGINT/SIGTERM are forwarded and the CLI waits for shutdown; cancellation stops before any upload or deployment even if the child exits gracefully with code 0.

The existing build safeguard is a 10-minute deadline, unlike cf's unbounded delegate build. A timed-out build receives SIGTERM and, after 5 seconds, SIGKILL if needed, then reports `BUILD_TIMEOUT`. This limit is separate from `deploy --timeout` (deployment polling). If a build takes longer, run it separately and use `--prebuilt`.

The CLI detects the project the same way `cf` does before building:

1. Read `package.json` and lockfiles to choose the package manager.
2. Detect a framework from its configuration file or dependency (Astro, Next.js, Nuxt, SvelteKit, Gatsby, Angular, Docusaurus, Remix, React Router, Qwik, Analog, Hugo, and Vite). Vite is treated as auxiliary when a more specific framework is present.
3. Prefer a package script whose command contains the framework build command, then `build`, then `build:*`.
4. Run the build through the detected package manager, or invoke the framework command with `npx`/`pnpm exec`/`yarn`/`bunx` when there is no script.
5. Normalize the framework output directory (`dist`, `build`, `out`, `public`, `.output/public`, and similar) to `dist/`.

The detection result (framework, package manager, build command, output directory, and warnings) is included in the deploy JSON as `detection`. Conflicting frameworks stop the build with `PREFLIGHT_MULTIPLE_FRAMEWORKS`.

When no framework or build script is found, the CLI prepares output according to the project type:

- Static site: copy the detected asset directory, `public/`, or the project root to `dist/`.
- Worker: copy `worker/index.js`, bundle a worker entry, or rebundle a detected worker output to `dist/server/index.js`.
- wrangler project: bundle `main` to `dist/server/index.js` with Rolldown.

The deployment stops during preflight if `dist/index.html` (static) or `dist/server/index.js` (Worker) is missing.

Use `--prebuilt` to skip build execution and normalization and deploy the current `dist/` directory. Framework detection, dirty-tree checks and artifact validation still run.

## Archive

The uploaded tar.gz has `dist/` at its root and includes `.openai/hosting.json`. When D1 is used, migrations are placed in `dist/.openai/drizzle/`.

- Symbolic links and special files are rejected.
- The expanded archive must not exceed 512 MiB.
- The archive is created in a temporary directory and is not left in the project.
- `upload_url` and `download_url` are never printed.

## Version deduplication

Sites may treat saving a version with the same `commit_sha` as a duplicate and return the existing version. If the artifact changed but the commit did not, the CLI creates an empty commit so the new artifact is saved as a new version.

## sites status

Show deployment status. Without an argument, the latest deployment from `.sites/state.json` is used.

```sh
npx @hayatosc/sites status
npx @hayatosc/sites status <deployment_id> --watch
```

| Flag               | Description                         |
| ------------------ | ----------------------------------- |
| `--watch`          | Poll until the deployment settles   |
| `--interval <sec>` | Polling interval (default 3)        |
| `--timeout <sec>`  | Wait timeout (default 300)          |

A `failed` or `error` status returns the status data, including `failure_message` when supplied, and exits 1.

## sites logs

Fetch Worker logs. Logs are pulled on demand.

```sh
npx @hayatosc/sites logs
npx @hayatosc/sites logs --since 2h --errors-only
npx @hayatosc/sites logs --follow
```

| Flag               | Description                                  |
| ------------------ | -------------------------------------------- |
| `--since <window>` | Window such as `30m`, `2h`, or `1d` (default 30m) |
| `--limit <n>`      | Number of events, 1 to 1000 (default 100)    |
| `--errors-only`    | Fetch errors only                            |
| `--all`            | Include non-error events (overrides `--errors-only`) |
| `--follow`         | Follow logs every 5 seconds                  |

When rate limited, `--follow` doubles the interval up to 60 seconds.

## When a deployment fails

1. Run `sites status <deployment_id>` and read `failure_message`.
2. Run `sites logs --errors-only --since 1h` to inspect Worker exceptions.
3. Run `sites doctor` to check authentication, the manifest, Git, and build output.
4. If needed, restore the previous version with `sites versions rollback <version_id>`.

Saved versions remain available even when a deployment fails.

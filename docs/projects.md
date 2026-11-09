# Projects

Sites are identified by `project_id` (`appgprj_...`). `init` and `create` store this ID in `.openai/hosting.json`; later commands use it when no project argument is given.

## sites init

Scaffold an empty directory or configure an existing detected project in the current or specified directory. Existing source/package/build files are preserved; linked manifests are not overwritten, even with `--force`.

```sh
npx @hayatosc/sites init
npx @hayatosc/sites init my-site --template worker-esm
```

| Flag                | Description                                  |
| ------------------- | -------------------------------------------- |
| `--template <name>` | `static` (default) or `worker-esm`           |
| `--force`           | Create files even if the directory is not empty |
| `--no-git`          | Do not initialize a Git repository           |

The `static` template creates `public/index.html` and a build script that copies `public/` to `dist/`. The `worker-esm` template creates `worker/index.js` and a build script that copies the Worker to `dist/server/index.js`.

## Local workflows

`sites build` runs detection, the project build and artifact inspection without auth or deployment. Child stdout/stderr appear immediately on stderr, leaving stdout for JSON. Native stdin/stderr are inherited to preserve TTY behavior; quiet suppresses child output. Build scripts retain their nonzero exit code. The existing 10-minute build deadline is retained for bounded automation; timeout sends SIGTERM, then SIGKILL after 5 seconds if needed. For longer builds, run the build separately and use `sites build --prebuilt` or `deploy --prebuilt`. Generic `--dry-run` previews arguments without invoking the build.

`sites dev -- <args..>` forwards literal arguments, including spaces, quotes and shell metacharacters, to the package manager without enabling Node's `shell: true`. The shared launch adapter handles Windows `.cmd` shims and native executables. It runs the package's dev script with native stdin/stdout/stderr inheritance (including TTY detection, colors and prompts) and preserves its exit status. SIGINT/SIGTERM are forwarded to the child; the CLI waits for shutdown and output drain rather than immediately exiting. A child that handles the signal may return 0 or its own nonzero code; signal termination returns 128 plus the signal number. It does not emulate Sites bindings; a dev script must already be configured.

`sites migrate [directory-or-config-file] --dry-run` stages Wrangler conversion in a temporary directory without modifying the project. Applying requires a clean Git tree unless `--force`; an existing manifest also requires `--force`, which retains its linked project ID. No dependencies are installed.

`sites complete [bash|zsh|fish|powershell]` prints shell setup; load it using your shell's normal configuration mechanism. `sites complete -- <words..>` prints local completion candidates. No shell rc files are edited.

## Local SQL migrations and binding types

`sites migrations create "add users"` scaffolds the next numbered SQL file in `drizzle/`, which the Sites Worker deployment pipeline consumes. `--dir <directory>` overrides the folder. The default selects top-level `.sql` files using standard directory enumeration. `--pattern '<dir>/<filename>.sql'` supports literal basename characters plus `*` (zero or more characters) and `?` (one Unicode character); for example `sql/????_*.sql`. It is case-sensitive, excludes hidden files and symlinks, and never recurses. The new file must match the pattern. Subdirectories, `**`, braces, character classes, negation, extglobs and parent-directory segments are rejected before any writes; arbitrary cf globs are intentionally not supported. A missing directory prompts on interactive input (default yes), or is created noninteractively. Names cannot contain path separators or nonportable filename characters, and existing files are never overwritten. Nested ORM migration layouts should use their own generator. This command needs no credentials or database and does **not** execute SQL; standalone migration list/apply is unavailable without a Sites SQL API.

`sites types` generates `.openai/types.d.ts` containing an `Env` interface for manifest D1/R2 bindings, without contacting a service or reading environment secrets. Use `--out` for another path and `--force` to replace a manually maintained file. Unchanged generated content is left untouched. The project must provide its own Workers runtime definitions for `D1Database`/`R2Bucket`. Full versioned runtime generation (`--include-runtime`) is not available; it is rejected rather than inventing a Sites runtime ABI. Both commands support argument-only `--dry-run` without filesystem changes.

## sites create

Create a site and save its `project_id` in `hosting.json`. If a `project_id` is already present, the command stops instead of creating another site.

```sh
npx @hayatosc/sites create my-site
npx @hayatosc/sites create my-site --title "My Site" --public
```

| Flag                    | Description                              |
| ----------------------- | ---------------------------------------- |
| `--title <title>`       | Display name for the site                |
| `--private`             | Private access (default)                 |
| `--public`              | Public access                            |
| `--workspace`           | Workspace access                         |
| `--dry-run`             | Validate without calling the API         |

The slug must contain lowercase letters, digits, and hyphens, and must start with a letter. A slug that is already in use cannot be created.

## sites list

List sites you can access.

```sh
npx @hayatosc/sites list
npx @hayatosc/sites list --all --role owner
```

| Flag                | Description                                  |
| ------------------- | -------------------------------------------- |
| `--limit <n>`       | Page size, 1 to 100 (default 20)             |
| `--cursor <cursor>` | Continue from a cursor                       |
| `--role <role>`     | Filter by `owner`, `editor`, or `viewer`     |
| `--all`             | Follow cursors and fetch every page          |

## sites info

Show site details, the latest version, and custom domains.

```sh
npx @hayatosc/sites info
npx @hayatosc/sites info my-site
npx @hayatosc/sites info appgprj_xxx --mcp
```

`--mcp` also fetches MCP connection details.

## sites open

Open the site in a browser. Use `--print` to print only the URL.

```sh
npx @hayatosc/sites open
npx @hayatosc/sites open my-site --path /pricing
npx @hayatosc/sites open --print
```

`--print` writes one URL line to stdout. `--path` resolves a path within the site's origin; cross-origin and non-HTTP(S) URLs are rejected.

## sites delete

Delete a site. This cannot be undone.

```sh
npx @hayatosc/sites delete my-site
npx @hayatosc/sites delete --force
```

`--force` (or `-f`) skips the confirmation prompt and is required when stdin is not a TTY. After confirmed deletion of the locally linked site, `project_id` in `hosting.json` is set to `null` and deployment/tag state is cleared; other manifest settings are preserved. A non-deletion response or deletion of another site leaves local state intact.

## Local state

`.sites/state.json` stores the most recent deployment details.

- `last_deployment_id`: the latest deployment ID
- `last_version_id`: the latest successfully deployed version ID
- `last_commit_sha`: the commit created by source sync
- `last_artifact_hash`: the hash of the uploaded artifact
- `last_uploaded_version_id`, `last_uploaded_commit_sha`, `last_uploaded_artifact_hash`: saved upload metadata, independent of activation
- `tags`: local tags created by `deploy --tag` or `versions create --tag`
- `last_rate_limited_at`: the most recent rate-limit time

Do not commit this file. `init` adds `.sites/` to `.gitignore`.

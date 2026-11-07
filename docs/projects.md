# Projects

Sites are identified by `project_id` (`appgprj_...`). `init` and `create` store this ID in `.openai/hosting.json`; later commands use it when no project argument is given.

## sites init

Create a project scaffold in the current directory or in a specified directory.

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
| `--description <text>`  | Site description                         |
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

`--print` writes one URL line to stdout. `--path` appends a path to the site URL.

## sites delete

Delete a site. This cannot be undone.

```sh
npx @hayatosc/sites delete my-site
npx @hayatosc/sites delete --yes
```

`--yes` is required when stdin is not a TTY. After deletion, `project_id` in `hosting.json` is set to `null`; other settings are preserved.

## Local state

`.sites/state.json` stores the most recent deployment details.

- `last_deployment_id`: the latest deployment ID
- `last_version_id`: the latest version ID
- `last_commit_sha`: the commit created by source sync
- `last_artifact_hash`: the hash of the uploaded artifact
- `tags`: local tags created by `deploy --tag`
- `last_rate_limited_at`: the most recent rate-limit time

Do not commit this file. `init` adds `.sites/` to `.gitignore`.

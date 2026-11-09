# Projects

Sites are identified by `project_id` (`appgprj_...`). Prepare `.openai/hosting.json` in an existing application project with `project_id: null`; `create` saves the returned ID. Later commands use it when no project argument is given.

Use your project's own tools for scaffolding, local development, SQL generation and runtime binding declarations. For a static project, the minimal manifest is:

```json
{
  "project_id": null,
  "static": { "directory": "dist" }
}
```

See the configuration manual for Worker manifests and the deployment manual for build execution and SQL packaging.

## sites complete

`sites complete [bash|zsh|fish|powershell]` prints shell setup; load it using your shell's normal configuration mechanism. `sites complete -- <words..>` prints local completion candidates. No shell rc files are edited.

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

The slug must be 1 to 63 lowercase letters, digits, or hyphens and start with a letter. A slug that is already in use cannot be created.

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
| `--all`             | Use 100-item pages, up to 50; repeated/remaining cursors fail rather than silently truncate |

## sites info

Show site details with best-effort latest-version and domain enrichment. Enrichment failures produce empty optional data rather than failing the site lookup.

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
- `last_rate_limited_at`: optional rate-limit time read by doctor; not currently written by the CLI

Do not commit this file. Add `.sites/` to your project's `.gitignore`.

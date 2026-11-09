# Operations

## Versions

Every deployment saves a version. You can redeploy a saved version to roll back.

```sh
npx @hayatosc/sites versions list
npx @hayatosc/sites versions get <version_id>  # show is also supported
npx @hayatosc/sites versions create --tag candidate  # upload only, no activation
npx @hayatosc/sites versions rollback <version_id> --force
npx @hayatosc/sites versions rollback --previous --force
```

`--previous` finds the prior successfully deployed version relative to the locally recorded successful deployment, skipping newer or never-deployed uploads. It refuses ambiguity or missing active-version metadata; pass an explicit version ID instead. Rollback requires confirmation (`--force` or `--yes` in noninteractive shells), redeploys without building/uploading, and returns a pending request. Use `status --watch` to check completion. Sites with custom access use a private deployment; other sites use a normal deployment.

`versions create` runs the same build/source/archive/upload/save steps as deploy but does not activate a deployment or modify audience/environment. `--prebuilt` skips the build; `--dry-run` builds/validates locally without remote effects. Uploaded metadata and tags are stored separately from the last deployment.

## Environment variables

```sh
npx @hayatosc/sites env list
npx @hayatosc/sites env get API_URL
npx @hayatosc/sites env set API_URL=https://example.com
npx @hayatosc/sites env set API_KEY=secret-value --secret
npx @hayatosc/sites env unset API_URL --force
```

`env unset` requires confirmation, as cf secret deletion does (`--force` or `--yes` for scripts).

Changes made by `env set` and `env unset` take effect on the next deployment. Saving a value alone does not change the running site.

`env pull` atomically replaces a local `.env` file with mode 0600. Values are quoted and escaped to preserve whitespace, newlines, quotes and comment characters. Secret values cannot be read from the API, so only their key names are written as comments.

```sh
npx @hayatosc/sites env pull
npx @hayatosc/sites env pull --out .env.local
```

`env push` sets every entry from a `.env` file. Use `--dry-run` to inspect the keys first, without credentials or network requests; values are never printed in the preview.

```sh
npx @hayatosc/sites env push --env-file .env
npx @hayatosc/sites env push --env-file .env --dry-run
```

## Access

```sh
npx @hayatosc/sites access show
npx @hayatosc/sites access set --private
npx @hayatosc/sites access set --public
npx @hayatosc/sites access set --workspace
npx @hayatosc/sites access set --private --allow-email user@example.com
```

Publishing via `--public` requires confirmation; use `--yes` in noninteractive shells. `--private`, `--public`, and `--workspace` are mutually exclusive. `--allow-email` is available for private and workspace access, but not public access.

`--wait` waits until the access mode actually changes. Propagation can take 40 to 60 seconds.

```sh
npx @hayatosc/sites access set --public --wait --timeout 120
```

## Custom domains

```sh
npx @hayatosc/sites domains add example.com
npx @hayatosc/sites domains list
npx @hayatosc/sites domains get example.com
npx @hayatosc/sites domains refresh example.com
npx @hayatosc/sites domains remove example.com
```

`domains add` prints the required DNS records; DNS configuration is not automated. After configuring DNS, run `refresh` to update the verification state. `domains add --wait` and `domains refresh --wait` poll until `active` or `active_redeploying`. Their timeout defaults to 900 seconds (maximum 3600); invalid values are rejected before an add request.

HTTPS certificate issuance can take additional time for custom domains.

## Analytics

```sh
npx @hayatosc/sites analytics summary
npx @hayatosc/sites analytics summary --since 7d --view classic
npx @hayatosc/sites analytics events --since 24h
```

`--since` accepts values such as `30m`, `24h`, and `7d`. Aggregation uses hourly buckets aligned to UTC-08:00. New data can take up to one hour to appear.

`--view` accepts `classic` or `list`. In event lists, the request-traffic view can be `null`.

## Diagnostics

```sh
npx @hayatosc/sites doctor
npx @hayatosc/sites doctor --offline
npx @hayatosc/sites doctor --fix-git
npx @hayatosc/sites doctor --verbose
```

`doctor` checks:

- The Node.js version.
- The auth file and token expiry.
- The MCP connection and the `plugin-runtime` response.
- Keys in `hosting.json`.
- Whether `project_id` matches the API site record.
- Unsupported wrangler features.
- Consistency between `dist` and the manifest.
- Uncommitted changes and divergence from the remote.
- Whether Git is available.
- The `build` script in `package.json`.
- Recent rate limiting.
- Consistency between local state and the actual deployment.

`--offline` skips checks that need the network. `--fix-git` creates a missing `.gitignore` and initializes Git when the project is not already a repository; existing ignore files are preserved. `--verbose` prints details for each check.

The command exits 0 when no check fails, and 1 when any check fails. Warnings alone exit 0.

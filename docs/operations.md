# Operations

## Versions

Every deployment saves a version. You can redeploy a saved version to roll back.

```sh
npx @hayatosc/sites versions list
npx @hayatosc/sites versions show <version_id>
npx @hayatosc/sites versions rollback <version_id>
npx @hayatosc/sites versions rollback --previous
```

`--previous` selects the second item in the version list, immediately before the latest version. Rollback redeploys an existing version; it does not create a new version. Sites with custom access use a private deployment; other sites use a normal deployment.

## Environment variables

```sh
npx @hayatosc/sites env list
npx @hayatosc/sites env get API_URL
npx @hayatosc/sites env set API_URL https://example.com
npx @hayatosc/sites env set API_KEY secret-value --secret
npx @hayatosc/sites env unset API_URL
```

Changes made by `env set` and `env unset` take effect on the next deployment. Saving a value alone does not change the running site.

`env pull` writes a local `.env` file. Secret values cannot be read from the API, so only their key names are written as comments.

```sh
npx @hayatosc/sites env pull
npx @hayatosc/sites env pull --out .env.local
```

`env push` sets every entry from a `.env` file. Use `--dry-run` to inspect the payload first.

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

`--private`, `--public`, and `--workspace` are mutually exclusive. `--allow-email` is available for private and workspace access, but not public access.

`--wait` waits until the access mode actually changes. Propagation can take 40 to 60 seconds.

```sh
npx @hayatosc/sites access set --public --wait --timeout 120
```

## Custom domains

```sh
npx @hayatosc/sites domains add example.com
npx @hayatosc/sites domains list
npx @hayatosc/sites domains refresh example.com
npx @hayatosc/sites domains remove example.com
```

`domains add` prints the required DNS records; DNS configuration is not automated. After configuring DNS, run `refresh` to update the verification state. `--wait` polls until the domain becomes `active`.

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

`--offline` skips checks that need the network. `--fix-git` adds missing `.gitignore` entries and initializes Git when needed. `--verbose` prints details for each check.

The command exits 0 when no check fails, and 1 when any check fails. Warnings alone exit 0.

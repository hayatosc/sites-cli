# Contributing

Thanks for contributing to `@hayatosc/sites`.

## Requirements

- Node.js **22.13** or newer
- npm (or a compatible package manager)

## Setup

```sh
git clone https://github.com/hayatosc/sites-cli.git
cd sites-cli
npm install
```

## Scripts

| Script | What it runs |
| --- | --- |
| `npm run typecheck` | `vp check` (lint + typecheck) |
| `npm test` | `vp test` |
| `npm run build` | `vp pack` → `dist/cli.mjs` |

All of these use [Vite+](https://viteplus.dev). The pack step embeds every Markdown file under `docs/` into the CLI for `sites docs search`.

## Project layout

- `src/` — CLI source (Gunshi commands, auth, MCP, deploy pipeline)
- `docs/` — user manual (bundled into the binary)
- `test/` — Vite+ tests
- `dist/cli.mjs` — built executable (gitignored; rebuilt by `prepack`)

## Documentation

- Keep the README and `docs/` aligned with **real** CLI behavior (`sites <command> --help` and the source of truth in `src/commands/`).
- Prefer English for user-facing docs (existing manual is English).
- Do not invent commands, flags, exit codes, or environment variables.
- Internal design notes that must not ship in the search index should stay outside `docs/` (everything under `docs/` is embedded).

## Pull requests

1. Create a branch from `main`.
2. Make focused changes; update docs when behavior changes.
3. Run `npm run typecheck`, `npm test`, and `npm run build` locally.
4. Open a PR with a short summary of what changed and how you verified it.

## Reporting issues

Use GitHub Issues on [hayatosc/sites-cli](https://github.com/hayatosc/sites-cli). Include the CLI version (`sites --version`), Node version, and the exact command plus stderr when possible. Do not paste access tokens or contents of `~/.codex/auth.json`.

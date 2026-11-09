# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-09

### Fixed

- Send only connector-schema fields in the `save_site_version` archive payload, excluding internal `file_size_bytes` metadata so deploys and version uploads pass schema validation.

## [0.1.0] - 2026-11-09

First published package shape for `@hayatosc/sites` (not yet on the npm registry at the time this file was added).

### Added

- CLI for creating, deploying, and operating ChatGPT Sites (`sites` binary).
- Authentication via `SITES_ACCESS_TOKEN` or shared Codex credentials in `~/.codex/auth.json`.
- Site lifecycle: `create`, `list`, `info`, `open`, `delete`.
- Deploy pipeline: build/normalize, source sync, upload, deploy, `status`, `logs`.
- Versions: `create`, `list`, `get`/`show`, `rollback`.
- Environment: `list`, `get`, `set`, `unset`, `pull`, `push`, plus deploy-time `--env-file` / `--secrets-file`.
- Access, custom domains, and analytics commands.
- Diagnostics: `doctor`, `auth whoami [--check]`.
- Discovery: `cli search`, `docs search` (manual bundled into the CLI), `schema` / `schema --list`.
- Shell completion via `complete`.
- Wrangler project conversion and Worker bundling with Rolldown.
- Framework detection and build-output normalization aligned with Cloudflare's `cf` CLI conventions.
- Global flags: `--human`, `--quiet`, `--no-color`, `--dry-run`, `--help`, `--version`.
- Exit codes `0` / `1` / `130`.

### Changed

- Migrated CLI parsing, help, and dispatch to Gunshi.
- Aligned command output with bare JSON success data (no `{ok,data,meta}` envelope).
- Agent help decoration now uses Gunshi's built-in agent detection.

### Removed

- Project tooling commands previously used for scaffolding / local workflows (use your project's own tools instead).
- `--json` envelope mode and `--yes`/`-y` confirmation aliases (use `--force` where supported).

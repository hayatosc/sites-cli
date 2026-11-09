// Bundled manual search.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { runCli, tempDir } from "./helpers/index.ts";

test("docs search reads the bundled manual from any working directory", async () => {
  const cwd = tempDir("sites-docs-");
  const result = await runCli(["docs", "search", "custom domain"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.length > 0);
  assert.ok(body.some((hit: { file: string }) => hit.file === "operations.md"));
  assert.ok(
    body.some((hit: { title: string }) => hit.title.toLowerCase().includes("custom domain")),
  );
  assert.match(body[0].url, /^https:\/\/github\.com\/hayatosc\/sites-cli\/blob\/main\/docs\//);
});

test("docs search finds deploy flags without a docs directory", async () => {
  const cwd = tempDir("sites-docs-");
  const result = await runCli(["docs", "search", "dry-run"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.length > 0);
  assert.ok(
    body.some(
      (hit: { file: string; title: string }) => hit.file === "deploy.md" || hit.title === "Output",
    ),
  );
});

test("docs search rejects an empty query", async () => {
  const result = await runCli(["docs", "search", ""]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Error: /);
});

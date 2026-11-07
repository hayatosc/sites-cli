// Bundled manual search.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { runCli, tempDir } from "./helpers/index.ts";

test("docs search reads the bundled manual from any working directory", async () => {
  const cwd = tempDir("sites-docs-");
  const result = await runCli(["docs", "search", "custom domain"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.data.results.length > 0);
  assert.ok(body.data.results.some((hit: { file: string }) => hit.file === "operations.md"));
  assert.ok(
    body.data.results.some((hit: { heading: string }) =>
      hit.heading.toLowerCase().includes("custom domain"),
    ),
  );
});

test("docs search finds deploy flags without a docs directory", async () => {
  const cwd = tempDir("sites-docs-");
  const result = await runCli(["docs", "search", "dry-run"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.data.results.length > 0);
  assert.ok(
    body.data.results.some((hit: { excerpt: string }) => hit.excerpt.includes("--dry-run")),
  );
});

test("docs search rejects an empty query", async () => {
  const result = await runCli(["docs", "search", ""]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "USAGE_EMPTY_QUERY");
});

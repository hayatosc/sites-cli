// Environment and secrets file parsing.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readEnvFile, readSecretsFile } from "../src/env-file.ts";
import { tempDir } from "./helpers/index.ts";

test("dotenv parsing supports quotes, comments, and expansion", () => {
  const root = tempDir("sites-env-");
  fs.writeFileSync(
    path.join(root, ".env"),
    [
      "# comment",
      "BASE=https://example.test",
      'export QUOTED="${BASE}/api"',
      "SINGLE='$BASE/literal'",
      "HASH=value # trailing comment",
    ].join("\n"),
  );
  const entries = readEnvFile(root, ".env");
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.value]),
    [
      ["BASE", "https://example.test"],
      ["QUOTED", "${BASE}/api"],
      ["SINGLE", "$BASE/literal"],
      ["HASH", "value"],
    ],
  );
});

test("secrets files expand earlier values and let process env win", () => {
  const root = tempDir("sites-secrets-");
  fs.writeFileSync(
    path.join(root, "secrets.env"),
    ["BASE=https://file.test", "TOKEN=${BASE}/token", "EMPTY=file"].join("\n"),
  );
  const entries = readSecretsFile(root, "secrets.env", {
    BASE: "https://process.test",
    EMPTY: "",
  });
  assert.deepEqual(entries, [
    { key: "BASE", value: "https://process.test" },
    { key: "TOKEN", value: "https://process.test/token" },
    { key: "EMPTY", value: "" },
  ]);
});

test("secrets files accept JSON objects", () => {
  const root = tempDir("sites-secrets-");
  fs.writeFileSync(
    path.join(root, "secrets.json"),
    JSON.stringify({ URL: "https://example.test", HOST: "${URL}/path", PORT: 8080 }),
  );
  assert.deepEqual(readSecretsFile(root, "secrets.json", {}), [
    { key: "URL", value: "https://example.test" },
    { key: "HOST", value: "https://example.test/path" },
    { key: "PORT", value: "8080" },
  ]);
});

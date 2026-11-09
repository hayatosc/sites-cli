// wrangler conversion and worker bundling.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { convertWranglerProject } from "../src/convert.ts";
import { findWranglerConfig, parseToml } from "../src/wrangler.ts";
import { runCli, tempDir } from "./helpers/index.ts";
import { CliError } from "../src/errors.ts";

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(root: string, relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as Record<string, unknown>;
}

async function convert(root: string, allowUnsupported: string[] = []) {
  return convertWranglerProject({ root, allowUnsupported, log: () => {} });
}

test("parseToml reads sections, array tables, and values", () => {
  const config = parseToml(`
name = "my-site" # comment
main = "src/index.ts"
compatibility_date = "2024-01-01"
[vars]
API_URL = "https://example.test"
[[d1_databases]]
binding = "DB"
database_name = "db"
migrations_dir = "migrations"
[[r2_buckets]]
binding = "BUCKET"
`);
  assert.equal(config.name, "my-site");
  assert.equal((config.vars as Record<string, string>).API_URL, "https://example.test");
  assert.equal(config.d1_databases?.[0]?.binding, "DB");
  assert.equal(config.r2_buckets?.[0]?.binding, "BUCKET");
});

test("findWranglerConfig prefers jsonc and strips comments", () => {
  const root = tempDir("sites-convert-");
  write(root, "wrangler.json", JSON.stringify({ name: "json" }));
  write(root, "wrangler.jsonc", `{\n  // comment\n  "name": "jsonc",\n}\n`);
  const found = findWranglerConfig(root);
  assert.equal(found?.format, "jsonc");
  assert.equal(found?.config.name, "jsonc");
});

test("static assets convert to hosting.json and dist", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.jsonc",
    JSON.stringify({
      name: "My Static Site",
      assets: { directory: "public", not_found_handling: "single-page-application" },
    }),
  );
  write(root, "public/index.html", "<h1>static</h1>");
  const report = await convert(root);
  assert.ok(report);
  assert.equal(report.kind, "static");
  const manifest = readJson(root, ".openai/hosting.json");
  assert.deepEqual(manifest.static, {
    directory: "dist",
    not_found_handling: "single-page-application",
  });
  assert.equal(fs.readFileSync(path.join(root, "dist/index.html"), "utf8"), "<h1>static</h1>");
  assert.ok(report.changed.some((entry) => entry.includes('slug "my-static-site"')));
  assert.deepEqual(report.outputs, [".openai/hosting.json", "dist/"]);
});

test("worker main is bundled and assets go to dist/client", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.json",
    JSON.stringify({
      name: "worker-site",
      main: "src/index.ts",
      assets: { directory: "public", binding: "WEBSITE" },
      d1_databases: [{ binding: "DB", database_name: "db" }],
      r2_buckets: [{ binding: "BUCKET" }],
      migrations_dir: "migrations",
      triggers: { crons: ["0 * * * *"] },
    }),
  );
  write(
    root,
    "src/index.ts",
    `import message from "./message.txt";\nexport default { async fetch() { return new Response(message); } };\n`,
  );
  write(root, "src/message.txt", "from worker");
  write(root, "public/app.js", "console.log('asset')");
  write(root, "migrations/0001_init.sql", "create table t (id integer);");
  const report = await convert(root);
  assert.ok(report);
  assert.equal(report.kind, "worker");
  const bundled = fs.readFileSync(path.join(root, "dist/server/index.js"), "utf8");
  assert.match(bundled, /from worker/);
  assert.match(bundled, /export\s*\{[^}]*as default|export default/);
  assert.ok(fs.existsSync(path.join(root, "dist/client/app.js")));
  assert.ok(fs.existsSync(path.join(root, "dist/.openai/drizzle/0001_init.sql")));
  const manifest = readJson(root, ".openai/hosting.json");
  assert.equal(manifest.d1, "DB");
  assert.equal(manifest.r2, "BUCKET");
  assert.equal(manifest.static, undefined);
  assert.ok(report.warnings.some((entry) => entry.code === "CONVERT_ASSETS_BINDING"));
  assert.ok(report.warnings.some((entry) => entry.code === "CONVERT_CRONS"));
});

test("a converted worker passes deploy preflight and packaging", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.json",
    JSON.stringify({
      name: "worker-dry-run",
      main: "src/index.ts",
      assets: { directory: "public" },
    }),
  );
  write(root, "src/index.ts", `export default { async fetch() { return new Response("ok"); } };\n`);
  write(root, "public/index.html", "asset");
  await convert(root);
  const manifest = readJson(root, ".openai/hosting.json");
  manifest.project_id = "appgprj_1";
  fs.writeFileSync(path.join(root, ".openai/hosting.json"), JSON.stringify(manifest));
  const result = await runCli(["deploy", "--dry-run"], { cwd: root });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout) as {
    kind: string;
    archive: { file_count: number };
  };
  assert.equal(payload.kind, "worker");
  assert.ok(payload.archive.file_count >= 2);
});

test("unsupported sections block without writing outputs", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.json",
    JSON.stringify({
      name: "blocked-site",
      assets: { directory: "public" },
      kv_namespaces: [{ binding: "KV", id: "x" }],
      durable_objects: { bindings: [] },
    }),
  );
  write(root, "public/index.html", "hello");
  await assert.rejects(
    () => convert(root),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "PREFLIGHT_UNSUPPORTED_BINDING" &&
      error.exitCode === 1,
  );
  assert.equal(fs.existsSync(path.join(root, ".openai/hosting.json")), false);
  assert.equal(fs.existsSync(path.join(root, "dist")), false);
});

test("--allow-unsupported demotes a blocked section to a warning", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.json",
    JSON.stringify({
      name: "kv-site",
      assets: { directory: "public" },
      kv_namespaces: [{ binding: "KV", id: "x" }],
    }),
  );
  write(root, "public/index.html", "hello");
  const report = await convert(root, ["kv"]);
  assert.ok(report);
  assert.ok(
    report.warnings.some((entry) => entry.code === "CONVERT_UNSUPPORTED_KV" && entry.demoted),
  );
  assert.ok(report.blocked.length > 0);
  assert.ok(fs.existsSync(path.join(root, "dist/index.html")));
});

test("a wasm import is blocked as unsupported", async () => {
  const root = tempDir("sites-convert-");
  write(root, "wrangler.json", JSON.stringify({ name: "wasm-site", main: "src/index.ts" }));
  write(
    root,
    "src/index.ts",
    `import mod from "./mod.wasm";\nexport default { fetch() { return new Response(String(mod)); } };\n`,
  );
  fs.writeFileSync(path.join(root, "src/mod.wasm"), Buffer.from([0, 97, 115, 109]));
  await assert.rejects(
    () => convert(root),
    (error: unknown) => error instanceof CliError && error.code === "PREFLIGHT_UNSUPPORTED_BINDING",
  );
  assert.equal(fs.existsSync(path.join(root, ".openai/hosting.json")), false);
});

test("more than one D1 binding is blocked", async () => {
  const root = tempDir("sites-convert-");
  write(
    root,
    "wrangler.json",
    JSON.stringify({
      name: "two-d1",
      assets: { directory: "public" },
      d1_databases: [{ binding: "A" }, { binding: "B" }],
    }),
  );
  write(root, "public/index.html", "hello");
  await assert.rejects(
    () => convert(root),
    (error: unknown) =>
      error instanceof CliError &&
      JSON.stringify((error as CliError).details).includes("CONVERT_MULTIPLE_D1"),
  );
});

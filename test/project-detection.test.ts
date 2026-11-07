// cf-style project detection and build-output normalization.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildSite } from "../src/build.ts";
import {
  detectProject,
  detectPackageManager,
  findStaticDirectory,
  readPackageJson,
} from "../src/project-detect.ts";
import { tempDir } from "./helpers/index.ts";

function write(root: string, relative: string, content = ""): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function project(pkg: Record<string, unknown> = {}): string {
  const root = tempDir("sites-detect-");
  write(root, "package.json", JSON.stringify(pkg));
  return root;
}

test("detects Vite from config and selects the build script", () => {
  const root = project({ devDependencies: { vite: "^7" }, scripts: { build: "vite build" } });
  write(root, "vite.config.ts", "export default {}");
  const detection = detectProject(root);
  assert.equal(detection.framework?.id, "vite");
  assert.equal(detection.buildScript, "build");
  assert.equal(detection.buildCommand, "vite build");
  assert.equal(detection.outputDirectory, "dist");
});

test("prefers Astro over its auxiliary Vite configuration", () => {
  const root = project({ dependencies: { astro: "^5", vite: "^7" } });
  write(root, "astro.config.mjs", "export default {}");
  write(root, "vite.config.ts", "export default {}");
  const detection = detectProject(root);
  assert.equal(detection.framework?.id, "astro");
});

test("detects a package script whose value contains the framework command", () => {
  const root = project({
    dependencies: { astro: "^5" },
    scripts: { "build:site": "astro build --site example" },
  });
  const detection = detectProject(root);
  assert.equal(detection.framework?.id, "astro");
  assert.equal(detection.buildScript, "build:site");
});

test("rejects conflicting frameworks", () => {
  const root = project({ dependencies: { astro: "^5", next: "^15" } });
  write(root, "astro.config.mjs", "export default {}");
  write(root, "next.config.ts", "export default {}");
  assert.throws(
    () => detectProject(root),
    (error: unknown) => (error as { code?: string }).code === "PREFLIGHT_MULTIPLE_FRAMEWORKS",
  );
});

test("detects package managers from declarations and lockfiles", () => {
  const declared = project({ packageManager: "pnpm@10.0.0" });
  assert.equal(detectPackageManager(declared, readPackageJson(declared)), "pnpm");

  const locked = project();
  write(locked, "yarn.lock", "");
  assert.equal(detectProject(locked).packageManager, "yarn");
});

test("finds static assets in an immediate child directory", () => {
  const root = project();
  write(root, "site/index.html", "<h1>site</h1>");
  assert.equal(findStaticDirectory(root), path.join(root, "site"));
});

test("copies detected static output into dist", async () => {
  const root = project();
  write(root, ".openai/hosting.json", JSON.stringify({ project_id: null, static: {} }));
  write(root, "site/index.html", "<h1>nested</h1>");
  const result = await buildSite({ root, noBuildScript: false, log: () => {} });
  assert.equal(result.mode, "static-copy");
  assert.equal(fs.readFileSync(path.join(root, "dist/index.html"), "utf8"), "<h1>nested</h1>");
});

test("normalizes a framework output directory into dist", async () => {
  const root = project({
    dependencies: { nuxt: "^4" },
    scripts: { build: "node build.mjs" },
  });
  write(root, "nuxt.config.ts", "export default {}");
  write(
    root,
    "build.mjs",
    `import fs from "node:fs";
fs.mkdirSync(".output/public", { recursive: true });
fs.writeFileSync(".output/public/index.html", "<h1>nuxt</h1>");
`,
  );
  write(root, ".openai/hosting.json", JSON.stringify({ project_id: null, static: {} }));
  const result = await buildSite({ root, noBuildScript: false, log: () => {} });
  assert.equal(result.mode, "script");
  assert.equal(result.detection.framework?.id, "nuxt");
  assert.equal(fs.readFileSync(path.join(root, "dist/index.html"), "utf8"), "<h1>nuxt</h1>");
});

test("rebundles worker output that lives inside dist", async () => {
  const root = project({ scripts: { build: "node build.mjs" } });
  write(
    root,
    "build.mjs",
    `import fs from "node:fs";
fs.mkdirSync("dist/server", { recursive: true });
fs.writeFileSync("dist/server/helper.js", "export const value = 1;");
fs.writeFileSync("dist/server/index.mjs", "import { value } from './helper.js'; export default { fetch() { return new Response(String(value)); } };");
`,
  );
  write(root, ".openai/hosting.json", JSON.stringify({ project_id: null }));
  const result = await buildSite({ root, noBuildScript: false, log: () => {} });
  assert.equal(result.mode, "worker-bundle");
  assert.equal(fs.existsSync(path.join(root, "dist/server/index.js")), true);
});

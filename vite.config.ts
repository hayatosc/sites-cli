import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.join(PROJECT_ROOT, "docs", "manual");
const VIRTUAL_DOCS = "virtual:sites-docs";
const RESOLVED_DOCS = "\0sites-docs";

interface BundledDoc {
  file: string;
  content: string;
}

function collectDocs(directory: string, prefix = ""): BundledDoc[] {
  const docs: BundledDoc[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      docs.push(...collectDocs(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      docs.push({
        file: relative,
        content: fs.readFileSync(path.join(directory, entry.name), "utf8"),
      });
    }
  }
  return docs.sort((left, right) => left.file.localeCompare(right.file));
}

function docsBundlePlugin() {
  return {
    name: "sites-docs-bundle",
    resolveId(id: string) {
      return id === VIRTUAL_DOCS ? RESOLVED_DOCS : undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_DOCS) return undefined;
      const docs = collectDocs(DOCS_ROOT, "manual");
      return `export const bundledDocs = ${JSON.stringify(docs)};`;
    },
  };
}

export default defineConfig({
  plugins: [docsBundlePlugin()],
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: true,
    deps: {
      neverBundle: ["rolldown"],
    },
    plugins: [docsBundlePlugin()],
    banner: "#!/usr/bin/env node",
    outputOptions: {
      entryFileNames: "cli.mjs",
    },
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "docs/**", "aube-lock.yaml"],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

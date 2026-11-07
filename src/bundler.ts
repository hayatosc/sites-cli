// Single-ESM Worker bundling with the bundled Rolldown (plan §7.3).

import fs from "node:fs";
import path from "node:path";
import { build } from "rolldown";
import { CliError, EXIT } from "./errors.ts";
import { findWranglerConfig } from "./wrangler.ts";

const TEXT_EXTENSIONS = new Set([".txt", ".html", ".json"]);
const BINARY_EXTENSIONS = new Set([
  ".wasm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".br",
  ".mp4",
  ".mp3",
]);

function extensionOf(id: string): string {
  const clean = id.split("?")[0];
  return path.extname(clean).toLowerCase();
}

function textPlugin() {
  return {
    name: "sites-text-assets",
    resolveId(source: string) {
      if (BINARY_EXTENSIONS.has(extensionOf(source))) {
        throw new CliError(
          "CONVERT_BINARY_ASSET",
          `Binary asset imports are not supported: ${source}`,
          {
            exitCode: EXIT.PREFLIGHT,
            hint: "Bundle or inline the asset before deploying.",
            details: { kind: "wasm", source },
          },
        );
      }
      return null;
    },
    load(id: string) {
      const extension = extensionOf(id);
      if (BINARY_EXTENSIONS.has(extension)) {
        throw new CliError(
          "CONVERT_BINARY_ASSET",
          `Binary asset imports are not supported: ${id}`,
          {
            exitCode: EXIT.PREFLIGHT,
            details: { kind: "wasm", source: id },
          },
        );
      }
      if (!TEXT_EXTENSIONS.has(extension)) return null;
      const text = fs.readFileSync(id, "utf8");
      return { code: `export default ${JSON.stringify(text)};`, moduleType: "js" as const };
    },
  };
}

export function validateBundleText(text: string, relative: string): void {
  if (!/\bexport\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b/.test(text)) {
    throw new CliError("PREFLIGHT_INVALID_BUNDLE", `${relative} has no default export.`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Bundle the Worker into a single ESM file with `export default { fetch }`.",
    });
  }
  if (/\brequire\s*\(/.test(text)) {
    throw new CliError("PREFLIGHT_INVALID_BUNDLE", `${relative} uses require().`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Emit a single ESM bundle without CommonJS requires.",
    });
  }
  if (/\bimport\.meta\.url\b/.test(text)) {
    throw new CliError("PREFLIGHT_INVALID_BUNDLE", `${relative} reads files via import.meta.url.`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Inline file contents at build time instead.",
    });
  }
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  for (const specifier of specifiers) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      throw new CliError(
        "PREFLIGHT_INVALID_BUNDLE",
        `${relative} imports a relative file: ${specifier}`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Bundle local modules into the single ESM output.",
        },
      );
    }
    if (!/^(cloudflare|node):/.test(specifier)) {
      throw new CliError(
        "PREFLIGHT_INVALID_BUNDLE",
        `${relative} imports a package: ${specifier}`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Only `cloudflare:*` and `node:*` imports are supported.",
        },
      );
    }
  }
}

export interface BundleOptions {
  root: string;
  entry: string;
  output?: string;
}

export async function bundleWorker(options: BundleOptions): Promise<string> {
  const output = options.output ?? path.join(options.root, "dist", "server", "index.js");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    await build({
      input: path.resolve(options.root, options.entry),
      platform: "neutral",
      external: [/^cloudflare:/, /^node:/],
      plugins: [textPlugin()],
      output: { file: output, format: "esm" },
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = (error as Error).message;
    if (message.includes("Binary asset imports are not supported")) {
      throw new CliError("CONVERT_BINARY_ASSET", message, {
        exitCode: EXIT.PREFLIGHT,
        details: { kind: "wasm" },
      });
    }
    throw new CliError("PREFLIGHT_BUNDLE_FAILED", `Rolldown failed: ${message}`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Fix bundling errors and retry.",
      details: { entry: options.entry },
    });
  }
  const text = fs.readFileSync(output, "utf8");
  validateBundleText(text, path.relative(options.root, output));
  return output;
}

export function resolveWorkerEntry(root: string): string | null {
  const wrangler = findWranglerConfig(root);
  if (wrangler?.config.main) {
    const resolved = path.resolve(root, wrangler.config.main);
    if (fs.existsSync(resolved)) return resolved;
    throw new CliError(
      "CONVERT_MAIN_MISSING",
      `Worker entry does not exist: ${wrangler.config.main}`,
      {
        exitCode: EXIT.PREFLIGHT,
      },
    );
  }
  for (const candidate of [
    "worker/index.js",
    "worker/index.ts",
    "src/worker.js",
    "src/worker.ts",
    "src/index.js",
    "src/index.ts",
    "index.js",
    "index.ts",
  ]) {
    const absolute = path.join(root, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

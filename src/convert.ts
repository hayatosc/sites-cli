// wrangler → hosting.json conversion (plan §7).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleWorker, validateBundleText } from "./bundler.ts";
import { CliError, EXIT } from "./errors.ts";
import {
  MANIFEST_DIR,
  manifestPath,
  writeManifest,
  type Manifest,
  type StaticConfig,
} from "./manifest.ts";
import type { FoundWrangler, WranglerConfig } from "./wrangler.ts";
import { findWranglerConfig } from "./wrangler.ts";

const MAX_ARCHIVE_BYTES = 536870912;
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const NOT_FOUND_VALUES = new Set(["none", "404-page", "single-page-application"]);
const TEXT_ASSET_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".json", ".html", ".txt"]);

export interface ConversionWarning {
  code: string;
  detail: string;
  kind?: string;
  demoted?: boolean;
}

export interface ConversionBlocked extends ConversionWarning {
  kind: string;
}

export interface ConversionReport {
  source: string;
  kind: "worker" | "static";
  manifest: Pick<Manifest, "d1" | "r2" | "static" | "capabilities">;
  changed: string[];
  warnings: ConversionWarning[];
  blocked: ConversionBlocked[];
  outputs: string[];
}

export interface ConvertOptions {
  root: string;
  allowUnsupported: string[];
  log: (text: string) => void;
}

function unsupportedSections(config: WranglerConfig): Array<[string, string]> {
  const candidates: Array<[string, string]> = [
    ["kv_namespaces", "kv"],
    ["durable_objects", "durable_objects"],
    ["queues", "queues"],
    ["services", "services"],
    ["hyperdrive", "hyperdrive"],
    ["vectorize", "vectorize"],
    ["ai", "ai"],
    ["browser", "browser"],
    ["rules", "rules"],
  ];
  return candidates.filter(([key]) => {
    const value = config[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

function scanForAssetsReference(root: string, entry: string | null): boolean {
  if (!entry) return false;
  const visited = new Set<string>();
  const queue = [entry];
  let checked = 0;
  while (queue.length > 0 && checked < 200) {
    const file = queue.pop() as string;
    if (visited.has(file) || !fs.existsSync(file)) continue;
    visited.add(file);
    if (!TEXT_ASSET_EXTENSIONS.has(path.extname(file))) continue;
    checked += 1;
    const text = fs.readFileSync(file, "utf8");
    if (/\benv\s*\.\s*ASSETS\b/.test(text)) return true;
    for (const match of text.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), match[1]);
      for (const candidate of [base, `${base}.js`, `${base}.ts`, path.join(base, "index.js")]) {
        if (fs.existsSync(candidate)) queue.push(candidate);
      }
    }
  }
  return false;
}

function migrationFiles(root: string): string[] {
  const dir = path.join(root, "drizzle");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name);
}

function makeSlug(name: string | undefined): string | null {
  if (!name) return null;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || !/^[a-z]/.test(slug)) return null;
  return slug.slice(0, 63).replace(/-$/, "");
}

function issue(code: string, detail: string, kind: string): ConversionBlocked {
  return { code, detail, kind };
}

export async function convertWranglerProject(options: ConvertOptions): Promise<ConversionReport | null> {
  const found = findWranglerConfig(options.root);
  if (!found) return null;
  const { config } = found;
  const warnings: ConversionWarning[] = [];
  const blocked: ConversionBlocked[] = [];
  const changed: string[] = [];

  const main = config.main ?? null;
  const assets = config.assets ?? null;
  const assetsDirectory = assets?.directory ?? null;
  const kind: "worker" | "static" = main ? "worker" : "static";

  const slug = makeSlug(config.name);
  if (config.name && !slug) {
    blocked.push(issue("CONVERT_INVALID_NAME", `Cannot derive a slug from name "${config.name}".`, "name"));
  }

  for (const [key, sectionKind] of unsupportedSections(config)) {
    blocked.push(
      issue(
        `CONVERT_UNSUPPORTED_${sectionKind.toUpperCase()}`,
        `The wrangler section "${key}" cannot be converted to hosting.json.`,
        sectionKind,
      ),
    );
  }
  if (/\bwasm\b/i.test(String(config.main ?? ""))) {
    blocked.push(issue("CONVERT_WASM", "Wasm imports are not supported.", "wasm"));
  }

  const d1List = config.d1_databases ?? [];
  const r2List = config.r2_buckets ?? [];
  if (d1List.length > 1) {
    blocked.push(issue("CONVERT_MULTIPLE_D1", "Only one D1 database can be converted.", "d1"));
  }
  if (r2List.length > 1) {
    blocked.push(issue("CONVERT_MULTIPLE_R2", "Only one R2 bucket can be converted.", "r2"));
  }
  const d1 = d1List[0]?.binding ?? null;
  const r2 = r2List[0]?.binding ?? null;
  if (d1 && !BINDING_PATTERN.test(d1)) {
    blocked.push(issue("CONVERT_INVALID_BINDING", `Invalid D1 binding name: ${d1}`, "d1"));
  }
  if (r2 && !BINDING_PATTERN.test(r2)) {
    blocked.push(issue("CONVERT_INVALID_BINDING", `Invalid R2 binding name: ${r2}`, "r2"));
  }
  const assetsBinding = assets?.binding;
  if (assetsBinding && assetsBinding !== "ASSETS") {
    warnings.push({
      code: "CONVERT_ASSETS_BINDING",
      detail: `assets.binding "${assetsBinding}" is replaced with the fixed ASSETS binding.`,
      kind: "assets",
    });
  }
  if (!main && !assetsDirectory) {
    blocked.push(issue("CONVERT_NO_ENTRY", "No main or assets.directory is configured.", "assets"));
  }
  const notFoundHandling = assets?.not_found_handling;
  if (notFoundHandling && !NOT_FOUND_VALUES.has(notFoundHandling)) {
    blocked.push(
      issue("CONVERT_INVALID_NOT_FOUND", `Unsupported not_found_handling: ${notFoundHandling}`, "assets"),
    );
  }

  // Bundle in a staging directory so a blocked conversion writes nothing.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "sites-convert-"));
  let bundled: string | null = null;
  try {
    if (main) {
      const entry = path.resolve(options.root, main);
      if (!fs.existsSync(entry)) {
        blocked.push(issue("CONVERT_MAIN_MISSING", `Worker entry does not exist: ${main}`, "esm"));
      } else {
        const stagedOutput = path.join(staging, "server", "index.js");
        try {
          bundled = await bundleWorker({ root: options.root, entry, output: stagedOutput });
        } catch (error) {
          const cli = error as CliError;
          if (cli.code === "CONVERT_BINARY_ASSET") {
            blocked.push(issue("CONVERT_BINARY_ASSET", cli.message, "wasm"));
          } else if (cli.code === "PREFLIGHT_INVALID_BUNDLE") {
            blocked.push(issue("CONVERT_INVALID_BUNDLE", cli.message, "esm"));
          } else {
            throw error;
          }
        }
      }
    }

    if (assetsDirectory) {
      const dir = path.resolve(options.root, assetsDirectory);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        blocked.push(issue("CONVERT_ASSETS_MISSING", `Assets directory does not exist: ${assetsDirectory}`, "assets"));
      }
    }

    const allow = new Set(options.allowUnsupported.map((entry) => entry.trim()).filter(Boolean));
    const remaining = blocked.filter((entry) => !allow.has(entry.kind));
    for (const entry of blocked) {
      if (allow.has(entry.kind)) {
        warnings.push({ ...entry, demoted: true });
      }
    }
    if (remaining.length > 0) {
      throw new CliError(
        "PREFLIGHT_UNSUPPORTED_BINDING",
        `Cannot convert ${found.relative}: ${remaining.map((entry) => entry.detail).join(" ")}`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Remove the unsupported sections, or pass --allow-unsupported <kind,...> to proceed anyway.",
          details: { blocked, warnings },
        },
      );
    }

    const manifest: Manifest = {
      project_id: null,
      d1,
      r2,
      capabilities: [],
    };
    if (!main) {
      manifest.static = {
        directory: "dist",
        not_found_handling: (notFoundHandling ?? "none") as StaticConfig["not_found_handling"],
      };
    }

    // Now that the conversion will succeed, write outputs.
    const dist = path.join(options.root, "dist");
    if (!main) {
      fs.rmSync(dist, { recursive: true, force: true });
      fs.mkdirSync(dist, { recursive: true });
      if (assetsDirectory) {
        fs.cpSync(path.resolve(options.root, assetsDirectory), dist, { recursive: true });
      }
      changed.push(`${assetsDirectory ?? "assets"} → dist`);
    } else {
      fs.mkdirSync(path.join(dist, "server"), { recursive: true });
      if (bundled) fs.copyFileSync(bundled, path.join(dist, "server", "index.js"));
      changed.push(`${main} → dist/server/index.js (Rolldown bundle)`);
      if (assetsDirectory) {
        fs.rmSync(path.join(dist, "client"), { recursive: true, force: true });
        fs.cpSync(path.resolve(options.root, assetsDirectory), path.join(dist, "client"), { recursive: true });
        changed.push(`${assetsDirectory} → dist/client`);
      }
    }

    const migrationsDir = config.migrations_dir ?? d1List[0]?.migrations_dir ?? "drizzle";
    const migrations = migrationFiles(options.root);
    if (d1) {
      const source = path.resolve(options.root, migrationsDir);
      if (fs.existsSync(source)) {
        const target = path.join(dist, MANIFEST_DIR, "drizzle");
        fs.mkdirSync(target, { recursive: true });
        fs.cpSync(source, target, { recursive: true });
        changed.push(`${migrationsDir} → dist/${MANIFEST_DIR}/drizzle`);
      }
      for (const file of migrations) {
        if (!/^\d{4,}_/.test(file)) {
          warnings.push({
            code: "CONVERT_MIGRATION_ORDER",
            detail: `Migration "${file}" is not zero-padded; migrations apply in filename order.`,
            kind: "migrations",
          });
        }
      }
      if (migrationsDir !== "drizzle") {
        warnings.push({
          code: "CONVERT_MIGRATIONS_DIR",
          detail: `migrations_dir "${migrationsDir}" was read at conversion time.`,
          kind: "migrations",
        });
      }
    }

    if (config.triggers?.crons?.length) {
      warnings.push({
        code: "CONVERT_CRONS",
        detail: "Cron triggers are not converted and will not run.",
        kind: "crons",
      });
    }
    if (config.compatibility_date || config.compatibility_flags?.length) {
      warnings.push({
        code: "CONVERT_COMPATIBILITY",
        detail: "compatibility_date/compatibility_flags are fixed by the platform; Node.js compatibility is always enabled.",
        kind: "compatibility",
      });
    }
    if (config.routes || config.custom_domains) {
      warnings.push({
        code: "CONVERT_ROUTES",
        detail: "routes/custom_domains are not converted; add domains with `sites domains add`.",
        kind: "routes",
      });
    }
    if (fs.existsSync(path.join(options.root, ".dev.vars"))) {
      warnings.push({
        code: "CONVERT_DEV_VARS",
        detail: ".dev.vars contains secrets and is never uploaded; use `sites env push` instead.",
        kind: "secrets",
      });
    }
    if (scanForAssetsReference(options.root, main ? path.resolve(options.root, main) : null)) {
      warnings.push({
        code: "CONVERT_ENV_ASSETS",
        detail: "The Worker references env.ASSETS; the binding is injected automatically.",
        kind: "assets",
      });
    }
    if (config.vars && Object.keys(config.vars).length > 0) {
      const stateDir = path.join(options.root, ".sites");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "conversion.json"),
        JSON.stringify({ vars: config.vars }, null, 2) + "\n",
      );
      changed.push("vars → .sites/conversion.json (applied on deploy)");
    }

    if (slug) {
      changed.unshift(`name → slug "${slug}"`);
    }
    writeManifest(options.root, manifest);
    changed.push(`${found.relative} → ${path.relative(options.root, manifestPath(options.root))}`);

    const outputs = [path.relative(options.root, manifestPath(options.root)).split(path.sep).join("/")];
    if (main) outputs.push("dist/server/index.js");
    if (assetsDirectory) outputs.push(main ? "dist/client/" : "dist/");
    if (d1 && fs.existsSync(path.join(dist, MANIFEST_DIR, "drizzle"))) {
      outputs.push(`dist/${MANIFEST_DIR}/drizzle/`);
    }

    const totalBytes = walkSize(dist);
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new CliError(
        "PREFLIGHT_ARCHIVE_TOO_LARGE",
        `The converted site is ${totalBytes} bytes; the maximum archive size is ${MAX_ARCHIVE_BYTES} bytes.`,
        { exitCode: EXIT.PREFLIGHT },
      );
    }

    options.log(`converted ${found.relative} (${kind})`);
    return {
      source: found.relative,
      kind,
      manifest: {
        d1: manifest.d1,
        r2: manifest.r2,
        static: manifest.static,
        capabilities: manifest.capabilities,
      },
      changed,
      warnings,
      blocked,
      outputs,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function walkSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) total += walkSize(absolute);
    else if (entry.isFile()) total += fs.statSync(absolute).size;
  }
  return total;
}

export function conversionSlug(found: FoundWrangler): string | null {
  return makeSlug(found.config.name);
}

export { SLUG_PATTERN };

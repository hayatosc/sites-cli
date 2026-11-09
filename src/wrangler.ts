// Reading wrangler configuration for the §7 conversion.

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";

export type WranglerFormat = "jsonc" | "json" | "toml";

export interface WranglerAssets {
  directory?: string;
  binding?: string;
  not_found_handling?: string;
}

export interface WranglerBinding {
  binding?: string;
  database_name?: string;
  migrations_dir?: string;
  [key: string]: unknown;
}

export interface WranglerConfig {
  name?: string;
  main?: string;
  assets?: WranglerAssets;
  d1_databases?: WranglerBinding[];
  r2_buckets?: WranglerBinding[];
  vars?: Record<string, unknown>;
  migrations_dir?: string;
  triggers?: { crons?: string[] };
  compatibility_date?: string;
  compatibility_flags?: string[];
  routes?: unknown;
  custom_domains?: unknown;
  kv_namespaces?: unknown;
  durable_objects?: unknown;
  queues?: unknown;
  services?: unknown;
  hyperdrive?: unknown;
  vectorize?: unknown;
  ai?: unknown;
  browser?: unknown;
  rules?: unknown;
  [key: string]: unknown;
}

export interface FoundWrangler {
  file: string;
  relative: string;
  format: WranglerFormat;
  config: WranglerConfig;
}

const CANDIDATES: Array<[string, WranglerFormat]> = [
  ["wrangler.jsonc", "jsonc"],
  ["wrangler.json", "json"],
  ["wrangler.toml", "toml"],
];

export function stripJsonc(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "{") {
      depth += 1;
      current += char;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseTomlValue(raw: string): unknown {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevel(value.slice(1, -1)).map(parseTomlValue);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

export function parseToml(text: string): WranglerConfig {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (const rawLine of text.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const key = line.slice(2, -2).trim();
      const array = (root[key] as Record<string, unknown>[] | undefined) ?? [];
      const entry: Record<string, unknown> = {};
      array.push(entry);
      root[key] = array;
      current = entry;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const key = line.slice(1, -1).trim();
      const parts = key.split(".");
      let target = root;
      for (const part of parts) {
        const next = target[part];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          target[part] = {};
        }
        target = target[part] as Record<string, unknown>;
      }
      current = target;
      continue;
    }
    const equal = line.indexOf("=");
    if (equal <= 0) continue;
    const key = line.slice(0, equal).trim();
    const value = parseTomlValue(line.slice(equal + 1));
    current[key] = value;
  }
  return root as WranglerConfig;
}

export function findWranglerConfig(root: string, configPath?: string): FoundWrangler | null {
  const extension = configPath ? path.extname(configPath).toLowerCase() : null;
  if (extension && ![".toml", ".json", ".jsonc"].includes(extension)) {
    throw new CliError(
      "CONVERT_INVALID_CONFIG",
      "Wrangler configuration must be TOML, JSON, or JSONC.",
      { exitCode: EXIT.PREFLIGHT },
    );
  }
  const candidates: typeof CANDIDATES = configPath
    ? [[configPath, extension === ".toml" ? "toml" : "jsonc"]]
    : CANDIDATES;
  for (const [name, format] of candidates) {
    const absolute = path.resolve(root, name);
    if (!fs.existsSync(absolute)) continue;
    let text: string;
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      throw new CliError(
        "CONVERT_READ_FAILED",
        `Could not read ${name}: ${(error as Error).message}`,
        {
          exitCode: EXIT.PREFLIGHT,
        },
      );
    }
    let config: WranglerConfig;
    try {
      config =
        format === "toml" ? parseToml(text) : (JSON.parse(stripJsonc(text)) as WranglerConfig);
    } catch (error) {
      throw new CliError(
        "CONVERT_INVALID_CONFIG",
        `Could not parse ${name}: ${(error as Error).message}`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Fix the configuration file and retry.",
        },
      );
    }
    return { file: absolute, relative: name, format, config };
  }
  return null;
}

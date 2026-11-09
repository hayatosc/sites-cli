// Environment and secrets file parsing.

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import type { Env } from "./types.ts";

export interface EnvFileEntry {
  key: string;
  value: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPANSION_PATTERN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function fileError(code: string, message: string, hint?: string): CliError {
  return new CliError(code, message, {
    exitCode: EXIT.PREFLIGHT,
    ...(hint ? { hint } : {}),
  });
}

function expand(value: string, lookup: (key: string) => string | undefined): string {
  return value.replace(EXPANSION_PATTERN, (_match, braced: string, plain: string) => {
    return lookup(braced ?? plain) ?? "";
  });
}

function parseValue(
  raw: string,
  lookup: (key: string) => string | undefined,
  doExpand: boolean,
): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    if (end > 0) return value.slice(1, end);
  }
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    if (end > 0) {
      let quoted = value.slice(1, end).replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
      });
      try {
        const decoded: unknown = JSON.parse(value.slice(0, end + 1));
        if (typeof decoded === "string") quoted = decoded;
      } catch {
        // Non-JSON dotenv escapes remain compatible with existing input files.
      }
      return doExpand ? expand(quoted, lookup) : quoted;
    }
  }
  const comment = value.search(/\s#/);
  const unquoted = comment === -1 ? value : value.slice(0, comment).trim();
  return doExpand ? expand(unquoted, lookup) : unquoted;
}

interface DotenvOptions {
  env: Env;
  expand: boolean;
  processOverrides: boolean;
}

/** Parses dotenv text with cf-compatible ordering and expansion rules. */
export function parseDotenv(raw: string, options: DotenvOptions): EnvFileEntry[] {
  const entries = new Map<string, string>();
  const lookup = (key: string): string | undefined => {
    if (options.processOverrides || options.expand) {
      const fromEnv = options.env[key];
      if (fromEnv !== undefined) return fromEnv;
    }
    return entries.get(key);
  };

  for (const original of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equal = withoutExport.indexOf("=");
    if (equal <= 0) {
      throw fileError(
        "PREFLIGHT_ENV_FILE",
        "Invalid environment file line (contents omitted).",
        "Use KEY=VALUE lines.",
      );
    }
    const key = withoutExport.slice(0, equal).trim();
    if (!KEY_PATTERN.test(key)) {
      throw fileError("PREFLIGHT_ENV_FILE", `Invalid environment variable name: ${key}`);
    }
    const value = parseValue(withoutExport.slice(equal + 1), lookup, options.expand);
    entries.set(key, value);
  }

  if (options.processOverrides) {
    for (const key of entries.keys()) {
      const fromEnv = options.env[key];
      if (fromEnv !== undefined) entries.set(key, fromEnv);
    }
  }
  return [...entries].map(([key, value]) => ({ key, value }));
}

function parseJson(raw: string, options: DotenvOptions): EnvFileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fileError("PREFLIGHT_ENV_FILE", "Invalid JSON environment file (contents omitted).");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fileError("PREFLIGHT_ENV_FILE", "The environment file must contain a JSON object.");
  }
  const entries = new Map<string, string>();
  const lookup = (key: string): string | undefined => {
    const fromEnv = options.env[key];
    if (fromEnv !== undefined) return fromEnv;
    return entries.get(key);
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEY_PATTERN.test(key)) {
      throw fileError("PREFLIGHT_ENV_FILE", `Invalid environment variable name: ${key}`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw fileError("PREFLIGHT_ENV_FILE", `Environment value for ${key} must be a scalar.`);
    }
    entries.set(key, options.expand ? expand(String(value), lookup) : String(value));
  }
  if (options.processOverrides) {
    for (const key of entries.keys()) {
      const fromEnv = options.env[key];
      if (fromEnv !== undefined) entries.set(key, fromEnv);
    }
  }
  return [...entries].map(([key, value]) => ({ key, value }));
}

function readFile(root: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file);
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    throw fileError("PREFLIGHT_ENV_FILE", `Cannot read environment file: ${file}`);
  }
}

/** Reads a plain KEY=VALUE file (quotes and comments are supported). */
export function readEnvFile(root: string, file: string): EnvFileEntry[] {
  return parseDotenv(readFile(root, file), {
    env: {},
    expand: false,
    processOverrides: false,
  });
}

/** Reads a JSON or dotenv secrets file using cf's expansion and precedence rules. */
export function readSecretsFile(root: string, file: string, env: Env): EnvFileEntry[] {
  const raw = readFile(root, file);
  const options: DotenvOptions = { env, expand: true, processOverrides: true };
  return raw.trimStart().startsWith("{") ? parseJson(raw, options) : parseDotenv(raw, options);
}

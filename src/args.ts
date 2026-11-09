// Gunshi schemas and compatibility normalization. Parsing and dispatch belong to Gunshi.

import { parseArgs, resolveArgs, type ArgSchema, type Args } from "gunshi";
import { detectAgentContext } from "./agent-context.ts";
import { usageError } from "./errors.ts";
import { textValue } from "./util.ts";
import type { CommandDefinition, Env } from "./types.ts";

interface FlagDefinition {
  type: "boolean" | "string";
  unsupported?: string;
  multiple?: true;
  description?: string;
}

export const FLAG_DEFS: Record<string, FlagDefinition> = {
  human: { type: "boolean", description: "Print human-readable output" },
  quiet: { type: "boolean", description: "Suppress result and progress output" },
  profile: { type: "string", description: "Unsupported: Sites shares Codex credentials" },
  "no-color": { type: "boolean", description: "Disable colors" },
  help: { type: "boolean", description: "Show help" },
  version: { type: "boolean", description: "Show version" },
  zone: { type: "string", unsupported: "-z/--zone" },
  "temporary-account": { type: "boolean", unsupported: "--temporary-account" },
  "event-code": { type: "string", unsupported: "--event-code" },
  local: { type: "boolean", unsupported: "--local" },
  "persist-to": { type: "string", unsupported: "--persist-to" },
  mode: { type: "string", unsupported: "-m/--mode" },
  check: { type: "boolean", description: "Connect to the MCP server and verify credentials" },
  limit: { type: "string", description: "Maximum number of items to return" },
  cursor: { type: "string", description: "Pagination cursor" },
  role: { type: "string", description: "Filter by role: owner, editor, or viewer" },
  all: { type: "boolean", description: "Fetch every page" },
  mcp: { type: "boolean", description: "Include MCP connection details" },
  force: { type: "boolean", description: "Skip confirmation" },
  title: { type: "string", description: "Site title" },
  private: { type: "boolean", description: "Use custom access" },
  public: { type: "boolean", description: "Make the site public" },
  workspace: { type: "boolean", description: "Allow workspace members" },
  "dry-run": { type: "boolean", description: "Validate without changing remote state" },
  prebuilt: { type: "boolean", description: "Deploy existing build output without building" },
  "no-build-script": { type: "boolean", description: "Skip the project build step" },
  "secrets-file": {
    type: "string",
    description: "Apply secret environment variables from JSON or dotenv",
  },
  message: { type: "string", description: "Source commit message" },
  tag: { type: "string", description: "Name this version in local state" },
  "env-file": { type: "string", description: "Apply environment variables from a file" },
  "no-source-sync": { type: "boolean", description: "Do not push source files" },
  "allow-dirty": { type: "boolean", description: "Deploy with uncommitted changes" },
  "allow-unsupported": {
    type: "string",
    multiple: true,
    description: "Downgrade named unsupported Wrangler features to warnings",
  },
  timeout: { type: "string", description: "Timeout in seconds" },
  watch: { type: "boolean", description: "Poll until the deployment finishes" },
  interval: { type: "string", description: "Polling interval in seconds" },
  since: { type: "string", description: "Time window, for example 30m or 24h" },
  "errors-only": { type: "boolean", description: "Only show error logs" },
  follow: { type: "boolean", description: "Keep polling for new entries" },
  previous: { type: "boolean", description: "Use the version before the current one" },
  secret: { type: "boolean", description: "Store the value as a secret" },
  out: { type: "string", description: "Output file" },
  "allow-email": { type: "string", multiple: true, description: "Allow a specific email" },
  wait: { type: "boolean", description: "Wait for the change to take effect" },
  view: { type: "string", description: "Analytics view: classic or list" },
  print: { type: "boolean", description: "Print the URL instead of opening it" },
  path: { type: "string", description: "Path to open" },
  list: { type: "boolean", description: "List available tools" },
  offline: { type: "boolean", description: "Skip network checks" },
  verbose: { type: "boolean", description: "Show details for every check" },
};

const SHORTS: Record<string, string> = {
  quiet: "q",
  force: "f",
  help: "h",
  version: "v",
  zone: "z",
  mode: "m",
};
export const GLOBAL_FLAGS = ["human", "quiet", "profile", "no-color", "dry-run", "help", "version"];

export function flagSchema(name: string): ArgSchema {
  const def = FLAG_DEFS[name];
  if (!def) throw new Error(`Missing flag schema: ${name}`);
  return {
    type: def.type,
    description: def.description,
    short: SHORTS[name],
    multiple: def.multiple,
    negatable: def.type === "boolean" && !name.startsWith("no-"),
    hidden: Boolean(def.unsupported),
  };
}

export const OPTION_SCHEMAS: Args = Object.fromEntries(
  Object.keys(FLAG_DEFS).map((name) => [name, flagSchema(name)]),
);

export function commandArgs(command: CommandDefinition): Args {
  const args: Args = Object.fromEntries(
    (command.flags ?? []).map((name) => [name, flagSchema(name)]),
  );
  const positional = command.positionals;
  if (positional?.max) {
    const names = positional.names ?? ["argument"];
    for (let index = 0; index < names.length; index++) {
      args[names[index]] = {
        type: "positional",
        required: index < positional.min,
        ...(positional.max === Infinity ? { multiple: true as const } : {}),
      };
    }
  }
  return args;
}

function optionName(name: string): string {
  const alias = Object.keys(SHORTS).find((key) => SHORTS[key] === name);
  if (alias) return alias;
  return Object.hasOwn(FLAG_DEFS, name) ? name : name.startsWith("no-") ? name.slice(3) : name;
}

export interface PreparedArgv {
  argv: string[];
  literal: string[];
}

/** Gunshi 0.37 does discovery before value resolution and treats inline booleans as truthy.
 * Canonicalize its tokens, not their parsing, to preserve existing flag placement and values.
 * Literal tails are opaque to Gunshi; their original bytes are delivered only to the handler.
 */
export function prepareArgv(input: string[]): PreparedArgv {
  const argv = input[0] === "help" ? [...input.slice(1), "--help"] : input;
  const tokens = parseArgs(argv);
  const normalized: (string | undefined)[] = [];
  const literal: string[] = [];
  const seen = new Set<string>();
  const presenceFlags = new Map<string, number>();
  let skip = -1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.index === skip) continue;
    if (token.kind === "option-terminator") {
      literal.push(...argv.slice(token.index + 1));
      break;
    }
    if (token.kind === "positional") {
      normalized.push(token.value ?? "");
      continue;
    }
    const name = optionName(token.name ?? "");
    const def = FLAG_DEFS[name];
    if (!def) {
      normalized.push(argv[token.index]);
      continue;
    }
    if (def.unsupported)
      throw usageError(
        "USAGE_UNSUPPORTED_FLAG",
        `The ${def.unsupported} flag is not supported by sites.`,
      );
    const next = tokens[index + 1];
    let value = token.value;
    if (
      !token.inlineValue &&
      next?.kind === "positional" &&
      next.index === token.index + 1 &&
      (def.type === "string" || /^(true|false)$/.test(next.value ?? ""))
    ) {
      value = next.value;
      skip = next.index;
    }
    if (def.type === "boolean") {
      if (value !== undefined && value !== "true" && value !== "false")
        throw usageError("USAGE_INVALID_FLAG_VALUE", `--${name} accepts only true or false.`);
      const enabled =
        value === undefined ? token.name === name || SHORTS[name] === token.name : value === "true";
      // Gunshi's built-in help/version do not accept native negation either.
      if (name.startsWith("no-") || name === "help" || name === "version") {
        const previous = presenceFlags.get(name);
        if (previous !== undefined) normalized[previous] = undefined;
        presenceFlags.delete(name);
        if (enabled) {
          presenceFlags.set(name, normalized.length);
          normalized.push(`--${name}`);
        }
      } else normalized.push(`--${enabled ? "" : "no-"}${name}`);
    } else {
      if (!value?.trim())
        throw usageError("USAGE_MISSING_FLAG_VALUE", `--${name} requires a nonempty value.`);
      if (seen.has(name) && !def.multiple)
        throw usageError("USAGE_DUPLICATE_FLAG", `--${name} may only be specified once.`);
      seen.add(name);
      normalized.push(`--${name}=${value}`);
    }
  }
  if (literal.length) normalized.push(...literal.map((value) => `sites-literal:${value}`));
  return { argv: normalized.filter((value): value is string => value !== undefined), literal };
}

/** Completion shares Gunshi's tokenizer, resolver and the registered command schemas. */
export function commandCompletions(words: string[], commands: CommandDefinition[]): string[] {
  const prefix = words.at(-1) ?? "";
  let prepared: PreparedArgv;
  try {
    prepared = prepareArgv(words.slice(0, -1));
  } catch {
    return [];
  }
  if (prepared.literal.length || words.slice(0, -1).includes("--")) return [];
  const parents = resolveArgs(OPTION_SCHEMAS, parseArgs(prepared.argv)).positionals;
  const visible = commands.filter((command) => !command.hidden);
  const exact = visible.find((command) =>
    command.path.every((part, index) => part === parents[index]),
  );
  const choices =
    prefix.startsWith("-") || exact
      ? [
          ...GLOBAL_FLAGS,
          ...Object.keys(exact?.gunshi?.args ?? {}).filter(
            (name) => exact?.gunshi?.args?.[name].type !== "positional",
          ),
        ].map((name) => `--${name}`)
      : visible
          .filter((command) => parents.every((part, index) => command.path[index] === part))
          .map((command) => command.path[parents.length])
          .filter((name): name is string => Boolean(name));
  return [...new Set(choices)].filter((choice) => choice.startsWith(prefix)).sort();
}

export function decorateHelp(help: string, env: Env): string {
  if (!detectAgentContext(env).isAgentic) return help;
  return `=== STOP: AGENT COMMAND DISCOVERY ===\nAGENTS: Do not explore commands by chaining nested --help calls.\nKeep queries anonymous: never include names, email addresses, domains, account/resource IDs or tokens.\nYour first port of call is sites cli search "<describe the task>".\nUse sites docs search "<question>" for the bundled manual.\nRun the discovered command with --help; use sites schema <tool> for MCP schemas.\n=== END AGENT COMMAND DISCOVERY ===\n${help}`;
}

export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[right.length];
}

export function integerOption(
  options: Record<string, unknown>,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = options[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw usageError(
      "USAGE_INVALID_VALUE",
      `Invalid --${name} value: ${textValue(raw, JSON.stringify(raw) ?? "unknown")}`,
      { hint: `Use an integer between ${min} and ${max}.` },
    );
  return value;
}

// CLI argument parsing, flag definitions, and help output (plan §3.2).

import { usageError } from "./errors.ts";
import type { CommandDefinition, ParsedCli, ResolvedCommand } from "./types.ts";

interface FlagDefinition {
  type: "boolean" | "string";
  unsupported?: string;
  multiple?: boolean;
}

const ALIASES: Record<string, string> = {
  "-q": "quiet",
  "-y": "yes",
  "-h": "help",
  "-v": "version",
  "-z": "zone",
  "-m": "mode",
};

// All flags the CLI knows about. Each command declares the subset it accepts.
export const FLAG_DEFS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
  human: { type: "boolean" },
  quiet: { type: "boolean" },
  profile: { type: "string" },
  "no-color": { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },

  // Cloudflare-only flags are rejected explicitly (plan §3.2).
  zone: { type: "boolean", unsupported: "-z/--zone" },
  local: { type: "boolean", unsupported: "--local" },
  "persist-to": { type: "string", unsupported: "--persist-to" },
  mode: { type: "string", unsupported: "-m/--mode" },

  check: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  role: { type: "string" },
  all: { type: "boolean" },
  mcp: { type: "boolean" },

  template: { type: "string" },
  force: { type: "boolean" },
  "no-git": { type: "boolean" },
  title: { type: "string" },
  private: { type: "boolean" },
  public: { type: "boolean" },
  workspace: { type: "boolean" },
  description: { type: "string" },
  "dry-run": { type: "boolean" },
  "no-build-script": { type: "boolean" },
  message: { type: "string" },
  tag: { type: "string" },
  "env-file": { type: "string" },
  "no-source-sync": { type: "boolean" },
  "allow-dirty": { type: "boolean" },
  "allow-unsupported": { type: "string", multiple: true },
  timeout: { type: "string" },
  watch: { type: "boolean" },
  interval: { type: "string" },
  since: { type: "string" },
  "errors-only": { type: "boolean" },
  follow: { type: "boolean" },


  previous: { type: "boolean" },
  secret: { type: "boolean" },
  out: { type: "string" },
  "allow-email": { type: "string", multiple: true },
  wait: { type: "boolean" },
  view: { type: "string" },
  print: { type: "boolean" },
  path: { type: "string" },
  offline: { type: "boolean" },
  "fix-git": { type: "boolean" },
  verbose: { type: "boolean" },
};

const GLOBAL_FLAGS = ["json", "human", "quiet", "profile", "no-color", "yes", "help", "version"];

const GROUPS: Record<string, string[]> = {
  auth: ["whoami"],
  versions: ["list", "show", "rollback"],
  env: ["list", "get", "set", "unset", "pull", "push"],
  access: ["show", "set"],
  domains: ["add", "list", "refresh", "remove"],
  analytics: ["summary", "events"],
  cli: ["search"],
  docs: ["search"],
};

function flagName(token: string): string | null {
  if (ALIASES[token]) return ALIASES[token];
  if (token.startsWith("--")) return token.slice(2);
  if (token.startsWith("-") && token.length === 2) return token.slice(1);
  return null;
}

interface ParsedFlag {
  name?: string;
  value?: string | boolean;
  needsValue?: boolean;
  unknown?: string;
}

function parseFlagToken(token: string): ParsedFlag {
  const equal = token.indexOf("=");
  const rawName = equal === -1 ? token : token.slice(0, equal);
  const inlineValue = equal === -1 ? undefined : token.slice(equal + 1);
  const name = flagName(rawName);
  if (!name) return { unknown: token };
  const def = FLAG_DEFS[name];
  if (!def) return { unknown: token };
  if (def.unsupported) {
    throw usageError("USAGE_UNSUPPORTED_FLAG", `The ${def.unsupported} flag is not supported by sites.`, {
      hint: "Sites has no corresponding option; remove the flag.",
    });
  }
  if (def.type === "boolean") {
    if (inlineValue !== undefined) {
      throw usageError("USAGE_INVALID_FLAG_VALUE", `Flag --${name} does not take a value.`);
    }
    return { name, value: true };
  }
  return { name, value: inlineValue, needsValue: inlineValue === undefined };
}

function resolveCommand(argv: string[], commands: CommandDefinition[]): ResolvedCommand | null {
  // Collect leading positional words, skipping flags and their values.
  const leading: Array<{ token: string; index: number }> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      const name = flagName(token.includes("=") ? token.slice(0, token.indexOf("=")) : token);
      const def = name ? FLAG_DEFS[name] : undefined;
      if (def?.type === "string" && !token.includes("=")) i += 1;
      continue;
    }
    leading.push({ token, index: i });
  }

  let best: ResolvedCommand | null = null;
  for (const command of commands) {
    if (command.path.length > leading.length) continue;
    const matches = command.path.every((part, index) => leading[index].token === part);
    if (!matches) continue;
    if (!best || command.path.length > best.path.length) {
      best = { ...command, consumedIndexes: leading.slice(0, command.path.length).map((entry) => entry.index) };
    }
  }
  return best;
}

export function parseCli(argv: string[], commands: CommandDefinition[]): ParsedCli {
  let help = false;
  let version = false;
  const command = resolveCommand(argv, commands);

  if (command) {
    const allowed = new Set([...GLOBAL_FLAGS, ...(command.flags ?? [])]);
    const result: ParsedCli = { command, options: {}, positionals: [], help: false, version: false };
    const consumed = new Set(command.consumedIndexes);

    for (let i = 0; i < argv.length; i += 1) {
      if (consumed.has(i)) continue;
      const token = argv[i];
      if (token === "--") {
        result.positionals.push(...argv.slice(i + 1));
        break;
      }
      if (token.startsWith("-") && token !== "-") {
        const parsed = parseFlagToken(token);
        if (parsed.unknown || !parsed.name) {
          throw usageError("USAGE_UNKNOWN_FLAG", `Unknown flag: ${token}`, {
            hint: "Run `sites --help` to see the supported flags.",
          });
        }
        if (!allowed.has(parsed.name)) {
          throw usageError(
            "USAGE_UNKNOWN_FLAG",
            `Unknown flag for \`sites ${command.path.join(" ")}\`: ${token}`,
            { hint: `Run \`sites ${command.path.join(" ")} --help\` to see the supported flags.` },
          );
        }
        let value = parsed.value;
        if (parsed.needsValue) {
          if (i + 1 >= argv.length) {
            throw usageError("USAGE_MISSING_VALUE", `Flag --${parsed.name} requires a value.`);
          }
          i += 1;
          value = argv[i];
        }
        if (parsed.name === "help") help = true;
        if (parsed.name === "version") version = true;
        const def = FLAG_DEFS[parsed.name];
        if (def.multiple) {
          const previous = result.options[parsed.name];
          const list = Array.isArray(previous) ? previous : [];
          result.options[parsed.name] = [...list, value];
        } else {
          result.options[parsed.name] = value;
        }
        continue;
      }
      result.positionals.push(token);
    }

    result.help = help;
    result.version = version;
    if (version || help) return result;

    const { min = 0, max = 0, names = [] } = command.positionals ?? {};
    if (result.positionals.length < min) {
      throw usageError(
        "USAGE_MISSING_ARGUMENT",
        `Missing argument: ${names[result.positionals.length] ?? "argument"}`,
        { hint: `Usage: ${command.usage ?? `sites ${command.path.join(" ")}`}` },
      );
    }
    if (result.positionals.length > max) {
      throw usageError(
        "USAGE_UNEXPECTED_ARGUMENT",
        `Unexpected argument: ${result.positionals[max]}`,
        { hint: `Usage: ${command.usage ?? `sites ${command.path.join(" ")}`}` },
      );
    }
    return result;
  }

  // No command matched. Allow --help / --version on their own.
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") help = true;
    else if (token === "--version" || token === "-v") version = true;
    else if (token === "--json" || token === "--human" || token === "-q" || token === "--quiet") continue;
    else if (token === "--no-color" || token === "-y" || token === "--yes") continue;
    else if (token === "--profile") {
      i += 1;
      continue;
    } else if (token.startsWith("-")) {
      const parsed = parseFlagToken(token);
      if (parsed.unknown) throw usageError("USAGE_UNKNOWN_FLAG", `Unknown flag: ${token}`);
      throw usageError("USAGE_MISSING_COMMAND", "No command was given.", {
        hint: "Run `sites --help` to see the available commands.",
      });
    } else if (GROUPS[token]) {
      throw usageError("USAGE_MISSING_SUBCOMMAND", `Missing subcommand for \`sites ${token}\`.`, {
        hint: `Use one of: ${GROUPS[token].join(", ")}.`,
      });
    } else {
      throw usageError("USAGE_UNKNOWN_COMMAND", `Unknown command: ${token}`, {
        hint: "Run `sites --help` to see the available commands.",
      });
    }
  }
  if (help || version) return { help, version, options: {}, positionals: [] };
  throw usageError("USAGE_MISSING_COMMAND", "No command was given.", {
    hint: "Run `sites --help` to see the available commands.",
  });
}

export function commandHelp(command: CommandDefinition): string {
  const lines = [`Usage: ${command.usage ?? `sites ${command.path.join(" ")}`}`];
  if (command.summary) lines.push("", command.summary);
  const flags = command.flags ?? [];
  if (flags.length) {
    lines.push("", "Options:");
    for (const flag of flags) {
      const def = FLAG_DEFS[flag];
      const suffix = def?.type === "string" ? " <value>" : "";
      lines.push(`  --${flag}${suffix}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function generalHelp(commands: CommandDefinition[]): string {
  const rows: Array<[string, string]> = commands.map((command) => [
    command.path.join(" "),
    command.summary ?? "",
  ]);
  const width = Math.max(0, ...rows.map(([name]) => name.length)) + 2;
  const lines = [
    "sites — deploy ChatGPT Sites projects from the command line",
    "",
    "Usage: sites <command> [options]",
    "",
    "Commands:",
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}${summary}`),
    "",
    "Global options:",
    "  --json             JSON output (default)",
    "  --human            Human-readable output",
    "  -q, --quiet        Suppress progress output on stderr",
    "  --profile <name>   Credential profile (Codex credentials are shared)",
    "  --no-color         Disable colors",
    "  -y, --yes          Assume yes for confirmation prompts",
    "  -h, --help         Show help",
    "  -v, --version      Show version",
  ];
  return lines.join("\n") + "\n";
}

/** Validates an integer option and converts range violations into usage errors. */
export function integerOption(
  options: Record<string, unknown>,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = options[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError("USAGE_INVALID_VALUE", `Invalid --${name} value: ${String(raw)}`, {
      hint: `Use an integer between ${min} and ${max}.`,
    });
  }
  return value;
}

export function isHumanRequested(argv: string[]): boolean {
  return argv.includes("--human");
}

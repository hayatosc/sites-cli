// CLI argument parsing, flag definitions, and help output (plan §3.2).

import { detectAgentContext } from "./agent-context.ts";
import { usageError } from "./errors.ts";
import { textValue } from "./util.ts";
import type { Env } from "./types.ts";
import type { CommandDefinition, ParsedCli, ResolvedCommand } from "./types.ts";

interface FlagDefinition {
  type: "boolean" | "string";
  unsupported?: string;
  multiple?: boolean;
  description?: string;
}

const ALIASES: Record<string, string> = {
  "-q": "quiet",
  "-y": "yes",
  "-f": "force",
  "-h": "help",
  "-v": "version",
  "-z": "zone",
  "-m": "mode",
};

// All flags the CLI knows about. Each command declares the subset it accepts.
export const FLAG_DEFS: Record<string, FlagDefinition> = {
  json: { type: "boolean", description: "Print the Sites JSON envelope and structured errors" },
  human: { type: "boolean", description: "Print human-readable output" },
  quiet: { type: "boolean", description: "Suppress result and progress output" },
  profile: { type: "string", description: "Unsupported: Sites shares Codex credentials" },
  "no-color": { type: "boolean", description: "Disable colors" },
  yes: { type: "boolean", description: "Assume yes for confirmation prompts" },
  help: { type: "boolean", description: "Show help" },
  version: { type: "boolean", description: "Show version" },

  // Cloudflare-only flags are rejected explicitly (plan §3.2).
  zone: { type: "string", unsupported: "-z/--zone" },
  "temporary-account": { type: "boolean", unsupported: "--temporary-account" },
  "event-code": { type: "string", unsupported: "--event-code" },
  local: { type: "boolean", unsupported: "--local" },
  "persist-to": { type: "string", unsupported: "--persist-to" },
  mode: { type: "string", unsupported: "-m/--mode" },

  dir: { type: "string", description: "Directory containing SQL migrations (default: drizzle)" },
  pattern: {
    type: "string",
    description: "Top-level SQL pattern under --dir; only * and ? wildcards",
  },
  "include-runtime": {
    type: "boolean",
    description: "Unsupported: Sites does not expose versioned runtime types",
  },
  check: { type: "boolean", description: "Connect to the MCP server and verify credentials" },
  limit: { type: "string", description: "Maximum number of items to return" },
  cursor: { type: "string", description: "Pagination cursor" },
  role: { type: "string", description: "Filter by role: owner, editor, or viewer" },
  all: { type: "boolean", description: "Fetch every page" },
  mcp: { type: "boolean", description: "Include MCP connection details" },

  template: { type: "string", description: "Project template: static or worker-esm" },
  force: { type: "boolean", description: "Skip confirmation or overwrite existing files" },
  "no-git": { type: "boolean", description: "Do not initialize a Git repository" },
  title: { type: "string", description: "Site title" },
  private: { type: "boolean", description: "Use custom access" },
  public: { type: "boolean", description: "Make the site public" },
  workspace: { type: "boolean", description: "Allow workspace members" },
  description: { type: "string", description: "Site description" },
  "dry-run": { type: "boolean", description: "Validate without changing remote state" },
  prebuilt: { type: "boolean", description: "Deploy existing build output without building" },
  "no-build-script": { type: "boolean", description: "Skip the project build step" },
  "secrets-file": {
    type: "string",
    description: "Apply secret environment variables from a JSON or dotenv file",
  },
  message: { type: "string", description: "Source commit message" },
  tag: { type: "string", description: "Name this version in local state" },
  "env-file": { type: "string", description: "Apply environment variables from a file" },
  "no-source-sync": { type: "boolean", description: "Do not push source files" },
  "allow-dirty": { type: "boolean", description: "Deploy with uncommitted changes" },
  "allow-unsupported": {
    type: "string",
    multiple: true,
    description: "Downgrade named unsupported wrangler features to warnings",
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
  "fix-git": { type: "boolean", description: "Initialize Git and write .gitignore when needed" },
  verbose: { type: "boolean", description: "Show details for every check" },
};

export const GLOBAL_FLAGS = [
  "json",
  "human",
  "quiet",
  "profile",
  "no-color",
  "yes",
  "help",
  "version",
  "dry-run",
];

const GROUPS: Record<string, string[]> = {
  auth: ["whoami"],
  migrations: ["create"],
  versions: ["list", "show", "get", "create", "rollback"],
  env: ["list", "get", "set", "unset", "pull", "push"],
  access: ["show", "set"],
  domains: ["add", "get", "list", "refresh", "remove"],
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
  if (rawName.startsWith("--no-") && !FLAG_DEFS[rawName.slice(2)]) {
    const positive = rawName.slice(5);
    if (FLAG_DEFS[positive]?.type === "boolean" && inlineValue === undefined) {
      return { name: positive, value: false };
    }
  }
  const name = flagName(rawName);
  if (!name) return { unknown: token };
  const def = FLAG_DEFS[name];
  if (!def) return { unknown: token };
  if (def.unsupported) {
    throw usageError(
      "USAGE_UNSUPPORTED_FLAG",
      `The ${def.unsupported} flag is not supported by sites.`,
      {
        hint: "Sites has no corresponding option; remove the flag.",
      },
    );
  }
  if (def.type === "boolean") {
    if (inlineValue !== undefined) {
      if (inlineValue === "true" || inlineValue === "false") {
        return { name, value: inlineValue === "true" };
      }
      throw usageError("USAGE_INVALID_FLAG_VALUE", `--${name} accepts only true or false.`);
    }
    return { name, value: true };
  }
  return { name, value: inlineValue, needsValue: inlineValue === undefined };
}

// Share argument boundaries between discovery, parsing, errors and completion.
export function flagArgumentEnd(argv: string[], index: number): number {
  const token = argv[index];
  if (token.includes("=")) return index;
  const name = flagName(token);
  let def = name ? FLAG_DEFS[name] : undefined;
  if (!def && name?.startsWith("no-") && FLAG_DEFS[name.slice(3)]?.type === "boolean")
    def = FLAG_DEFS[name.slice(3)];
  const next = argv[index + 1];
  if (def?.type === "string" && next !== undefined && !next.startsWith("-")) return index + 1;
  if (def?.type === "boolean" && /^(true|false)$/.test(next ?? "")) return index + 1;
  return index;
}

// Parsing may fail before output flags are reached. Recover only presentation
// options, using the same value boundaries and last-flag-wins semantics.
export function errorOutputOptions(argv: string[]): Record<string, boolean> {
  const options: Record<string, boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--") break;
    if (!argv[i].startsWith("-")) continue;
    const end = flagArgumentEnd(argv, i);
    try {
      const parsed = parseFlagToken(argv[i]);
      if (
        (parsed.name === "json" || parsed.name === "no-color") &&
        typeof parsed.value === "boolean"
      )
        options[parsed.name] = end > i ? argv[end] === "true" : parsed.value;
    } catch {
      // Keep the original parse error; malformed/unrelated flags set no mode.
    }
    i = end;
  }
  return options;
}

export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
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

function closestCommand(token: string, commands: CommandDefinition[]): string | null {
  const candidates = [...new Set(commands.map((command) => command.path.join(" ")))];
  let best: { command: string; distance: number } | null = null;
  for (const command of candidates) {
    const distance = editDistance(token.toLowerCase(), command.toLowerCase());
    if (
      distance <= Math.max(1, Math.floor(token.length / 3)) &&
      (!best || distance < best.distance)
    ) {
      best = { command, distance };
    }
  }
  return best?.command ?? null;
}

function resolveCommand(argv: string[], commands: CommandDefinition[]): ResolvedCommand | null {
  // Collect leading positional words, skipping flags and their values.
  const leading: Array<{ token: string; index: number }> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      i = flagArgumentEnd(argv, i);
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
      best = {
        ...command,
        consumedIndexes: leading.slice(0, command.path.length).map((entry) => entry.index),
      };
    }
  }
  return best;
}

function defIsEmptyString(name: string, value: unknown): boolean {
  return FLAG_DEFS[name].type === "string" && typeof value === "string" && !value.trim();
}

export function parseCli(argv: string[], commands: CommandDefinition[]): ParsedCli {
  let help = false;
  let version = false;
  let helpGroup: string | undefined;
  const command = resolveCommand(argv, commands);

  if (command) {
    const allowed = new Set([...GLOBAL_FLAGS, ...(command.flags ?? [])]);
    const result: ParsedCli = {
      command,
      options: {},
      positionals: [],
      help: false,
      version: false,
    };
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
          if (command.forwardArgs) {
            result.positionals.push(token);
            continue;
          }
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
        const end = flagArgumentEnd(argv, i);
        if (FLAG_DEFS[parsed.name].type === "boolean" && end > i) value = argv[end] === "true";
        if (parsed.needsValue) {
          if (end === i)
            throw usageError("USAGE_MISSING_VALUE", `Flag --${parsed.name} requires a value.`);
          value = argv[end];
        }
        i = end;
        if (defIsEmptyString(parsed.name, value))
          throw usageError(
            "USAGE_MISSING_VALUE",
            `Flag --${parsed.name} requires a non-empty value.`,
          );
        if (parsed.name === "help") help = Boolean(value);
        if (parsed.name === "version") version = Boolean(value);
        const def = FLAG_DEFS[parsed.name];
        if (def.multiple) {
          const previous = result.options[parsed.name];
          const list = Array.isArray(previous) ? previous : [];
          result.options[parsed.name] = [...list, value];
        } else {
          if (def.type === "string" && result.options[parsed.name] !== undefined) {
            throw usageError(
              "USAGE_DUPLICATE_FLAG",
              `Flag --${parsed.name} may only be supplied once.`,
            );
          }
          result.options[parsed.name] = value;
        }
        continue;
      }
      result.positionals.push(token);
    }

    if (result.options.json && result.options.human) {
      throw usageError("USAGE_CONFLICTING_FLAGS", "Choose either --json or --human, not both.");
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

  // With no command, cf displays root help. Still validate all global options.
  const options: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("-")) {
      const parsed = parseFlagToken(token);
      if (parsed.unknown || !parsed.name || !GLOBAL_FLAGS.includes(parsed.name))
        throw usageError("USAGE_UNKNOWN_FLAG", `Unknown flag: ${token}`);
      let value = parsed.value;
      const end = flagArgumentEnd(argv, i);
      if (FLAG_DEFS[parsed.name].type === "boolean" && end > i) value = argv[end] === "true";
      if (parsed.needsValue) {
        if (end === i)
          throw usageError("USAGE_MISSING_VALUE", `Flag --${parsed.name} requires a value.`);
        value = argv[end];
      }
      i = end;
      if (defIsEmptyString(parsed.name, value))
        throw usageError(
          "USAGE_MISSING_VALUE",
          `Flag --${parsed.name} requires a non-empty value.`,
        );
      if (FLAG_DEFS[parsed.name].type === "string" && options[parsed.name] !== undefined)
        throw usageError(
          "USAGE_DUPLICATE_FLAG",
          `Flag --${parsed.name} may only be supplied once.`,
        );
      options[parsed.name] = value;
      if (parsed.name === "help") help = Boolean(value);
      if (parsed.name === "version") version = Boolean(value);
    } else if (GROUPS[token] && !helpGroup) {
      helpGroup = token;
    } else {
      const suggestion = closestCommand(token, commands);
      throw usageError("USAGE_UNKNOWN_COMMAND", `Unknown command: ${token}`, {
        hint: suggestion
          ? `Did you mean \`sites ${suggestion}\`? Run \`sites --help\` to see all commands.`
          : "Run `sites --help` to see the available commands.",
      });
    }
  }
  if (options.json && options.human)
    throw usageError("USAGE_CONFLICTING_FLAGS", "Choose either --json or --human, not both.");
  if (helpGroup && !help && !version)
    throw usageError("USAGE_MISSING_SUBCOMMAND", `Missing subcommand for \`sites ${helpGroup}\`.`, {
      hint: `Use one of: ${GROUPS[helpGroup].join(", ")}.`,
    });
  return {
    help: help || !version,
    version,
    options,
    positionals: [],
    ...(helpGroup ? { helpGroup } : {}),
  };
}

const AGENT_DISCOVERY_HELP = [
  "=== STOP: AGENT COMMAND DISCOVERY ===",
  "AGENTS: Do not explore commands by chaining nested --help calls.",
  "Your first port of call and the best way to discover commands is:",
  "AGENTS: Keep sites cli search and sites docs search queries anonymous; describe the action and resource type only.",
  "Never include names, email addresses, domains, account or resource IDs, tokens, or other identifying values.",
  '  sites cli search "<describe the task you want to accomplish>"',
  "It returns five compact JSON matches with short descriptions. Pick the best match instead of repeating similar searches.",
  "Run `<discovered command> --help` for detailed command help.",
  "For MCP tool schemas, run sites schema <tool>.",
  'For ChatGPT Sites documentation, use sites docs search "<question>".',
  "It returns ranked JSON results from the bundled manual.",
  "=== END AGENT COMMAND DISCOVERY ===",
].join("\n");

function decorateHelp(help: string, env?: Env): string {
  return detectAgentContext(env).isAgentic ? `${AGENT_DISCOVERY_HELP}\n${help}` : help;
}

const VALUE_PLACEHOLDERS: Record<string, string> = {
  profile: "name",
  limit: "number",
  cursor: "cursor",
  role: "role",
  template: "name",
  title: "title",
  description: "text",
  message: "message",
  tag: "tag",
  "env-file": "path",
  "secrets-file": "path",
  "allow-unsupported": "kinds",
  timeout: "seconds",
  interval: "seconds",
  since: "window",
  out: "path",
  "allow-email": "email",
  view: "view",
  path: "path",
};

function quoteFlag(name: string, def: FlagDefinition | undefined): string {
  const aliases: Record<string, string> = {
    quiet: "-q, ",
    yes: "-y, ",
    force: "-f, ",
    help: "-h, ",
    version: "-v, ",
  };
  const placeholder = def?.type === "string" ? ` <${VALUE_PLACEHOLDERS[name] ?? "value"}>` : "";
  return `${aliases[name] ?? ""}--${name}${placeholder}`;
}

export function commandHelp(command: CommandDefinition, env?: Env): string {
  const lines = [`Usage: ${command.usage ?? `sites ${command.path.join(" ")}`}`];
  if (command.summary) lines.push("", command.summary);
  const flags = [...new Set([...(command.flags ?? []), "dry-run"])];
  if (flags.length) {
    lines.push("", "Options:");
    const rows = flags.map((flag) => {
      const def = FLAG_DEFS[flag];
      return { label: quoteFlag(flag, def), description: def?.description ?? "" };
    });
    const width = Math.max(...rows.map((row) => row.label.length)) + 2;
    for (const row of rows) {
      lines.push(`  ${row.label.padEnd(width)}${row.description}`);
    }
  }
  lines.push(
    "",
    "Global options: --json, --human, -q/--quiet, --profile, --no-color, -y/--yes, --dry-run, -h/--help, -v/--version",
  );
  return decorateHelp(lines.join("\n") + "\n", env);
}

export function groupHelp(group: string, commands: CommandDefinition[], env?: Env): string {
  const rows = commands
    .filter((command) => command.path[0] === group && !command.hidden)
    .map((command) => [command.path.slice(1).join(" "), command.summary ?? ""]);
  const width = Math.max(0, ...rows.map(([name]) => name.length)) + 2;
  const lines = [
    `Usage: sites ${group} <command> [options]`,
    "",
    "Commands:",
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}${summary}`),
    "",
    `Run \`sites ${group} <command> --help\` for flags.`,
  ];
  return decorateHelp(lines.join("\n") + "\n", env);
}

export function generalHelp(commands: CommandDefinition[], env?: Env): string {
  const rows: Array<[string, string]> = commands
    .filter((command) => !command.hidden)
    .map((command) => [command.path.join(" "), command.summary ?? ""]);
  const width = Math.max(0, ...rows.map(([name]) => name.length)) + 2;
  const lines = [
    "sites — deploy ChatGPT Sites projects from the command line",
    "",
    `Usage: sites <command> [options]`,
    "",
    "Commands:",
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}${summary}`),
    "",
    "Global options:",
    "  --json             Sites JSON envelope (default: bare JSON)",
    "  --human            Human-readable output",
    "  -q, --quiet        Suppress result and progress output",
    "  --dry-run          Preview without running (native deploy previews build locally)",
    "  --profile <name>   Credential profile (Codex credentials are shared)",
    "  --no-color         Disable colors",
    "  -y, --yes          Assume yes for confirmation prompts",
    "  -h, --help         Show help",
    "  -v, --version      Show version",
  ];
  return decorateHelp(lines.join("\n") + "\n", env);
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
    throw usageError(
      "USAGE_INVALID_VALUE",
      `Invalid --${name} value: ${textValue(raw, JSON.stringify(raw) ?? "unknown")}`,
      {
        hint: `Use an integer between ${min} and ${max}.`,
      },
    );
  }
  return value;
}

export function isHumanRequested(argv: string[]): boolean {
  return argv.includes("--human");
}

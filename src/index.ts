// Gunshi owns CLI parsing, validation, help and dispatch; Sites owns API execution and output.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { cli, define, plugin, parseArgs, resolveArgs } from "gunshi";
import {
  decorateHelp,
  editDistance,
  flagSchema,
  GLOBAL_FLAGS,
  OPTION_SCHEMAS,
  prepareArgv,
} from "./args.ts";
import { createCommands, createCommandTree } from "./commands/index.ts";
import { loadAuthIdentity } from "./auth.ts";
import type { Identity } from "./auth.ts";
import { McpClient } from "./mcp.ts";
import { CliError, CommandExit, EXIT, usageError, normalizeExitCode } from "./errors.ts";
import { colorEnabled, printError } from "./output.ts";
import type { CommandContext, Env, OutputStream } from "./types.ts";
import { forwardSignal, runCleanup, stringifyJson } from "./util.ts";

export { registerCleanup } from "./util.ts";

export interface MainOptions {
  env?: Env;
  cwd?: string;
  stdout?: OutputStream;
  stderr?: OutputStream;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const commands = createCommands();
  let exitCode = EXIT.OK as number;
  let color = false;
  let hasLiteral = false;
  try {
    const prepared = prepareArgv(argv);
    hasLiteral = prepared.literal.length > 0;
    const subCommands = createCommandTree(commands, async (command, native) => {
      const values = native.values;
      const end = prepared.literal.length
        ? native.positionals.length - prepared.literal.length
        : native.positionals.length;
      const positionals = [
        ...native.positionals.slice(command.path.length, end),
        ...prepared.literal,
      ];
      const arity = command.positionals;
      if (arity && (positionals.length < arity.min || positionals.length > arity.max)) {
        throw usageError(
          "USAGE_POSITIONAL_COUNT",
          `Expected ${arity.min === arity.max ? arity.min : `${arity.min} to ${arity.max}`} arguments for ${command.path.join(" ")}.`,
          { hint: command.usage },
        );
      }
      color = colorEnabled(stderr, values, env);
      if (values.profile)
        throw usageError(
          "USAGE_UNSUPPORTED_FLAG",
          "--profile is not supported: Sites uses shared Codex credentials.",
        );
      const quiet = Boolean(values.quiet);
      let identity: Identity | null = null;
      let client: McpClient | null = null;
      const getIdentity = (): Identity => (identity ??= loadAuthIdentity(env));
      const ctx: CommandContext = {
        argv,
        command,
        options: values,
        positionals,
        env,
        cwd,
        root: cwd,
        stdout: quiet ? { write: () => {}, isTTY: stdout.isTTY } : stdout,
        stderr: quiet ? { write: () => {}, isTTY: stderr.isTTY } : stderr,
        json: !values.human,
        quiet,
        getIdentity,
        log: (text) => {
          if (!quiet) stderr.write(text + "\n");
        },
        success: (text) => {
          if (!quiet && stderr.isTTY) stderr.write(`✓ ${text}\n`);
        },
        mcp: () => (client ??= new McpClient(getIdentity(), { env })),
      };
      const result =
        values["dry-run"] && !command.nativeDryRun
          ? {
              data: {
                command: `sites ${command.path.join(" ")}`,
                dryRun: true,
                executed: false,
                validated: "arguments only",
              },
            }
          : await command.run(ctx);
      exitCode = normalizeExitCode(result.exitCode ?? EXIT.OK);
      if (quiet) return;
      if (result.raw !== undefined) stdout.write(result.raw);
      else if (!ctx.json && result.human) result.human(result.data);
      else stdout.write(stringifyJson(result.data) + "\n");
    });
    const globalFlags = plugin({
      id: "sites:global-flags",
      setup: (ctx) => {
        for (const name of GLOBAL_FLAGS)
          if (name !== "help" && name !== "version") ctx.addGlobalOption(name, flagSchema(name));
      },
    });
    const input = resolveArgs(OPTION_SCHEMAS, parseArgs(prepared.argv)).positionals.length
      ? prepared.argv
      : [...prepared.argv, "--help"];
    const rendered = await cli(
      input,
      define({
        name: "sites",
        description: "Deploy ChatGPT Sites projects from the command line",
        toKebab: false,
      }),
      {
        name: "sites",
        version: "0.1.0",
        cwd,
        subCommands,
        plugins: [globalFlags],
        strict: true,
        usageSilent: true,
        renderValidationErrors: null,
      },
    );
    if (typeof rendered === "string")
      stdout.write((input.includes("--version") ? rendered : decorateHelp(rendered)) + "\n");
    return exitCode;
  } catch (error) {
    if (error instanceof CommandExit) return EXIT.INTERRUPT;
    const rawMessage =
      error instanceof AggregateError
        ? error.errors
            .map((item: unknown) => (item instanceof Error ? item.message : String(item)))
            .join(" ")
        : error instanceof Error
          ? error.message
          : String(error);
    const message = hasLiteral
      ? rawMessage.replace(/^Command not found: sites-literal:/, "Command not found: ")
      : rawMessage;
    const missing = /^Command not found: (.+)$/.exec(message)?.[1];
    const suggestion = missing
      ? commands
          .filter((command) => !command.hidden)
          .map((command) => ({
            path: command.path.join(" "),
            distance: editDistance(missing, command.path.join(" ")),
          }))
          .filter((entry) => entry.distance <= 2)
          .sort((left, right) => left.distance - right.distance)[0]
      : undefined;
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("CLI_ERROR", message, {
            hint: suggestion ? `Did you mean \`sites ${suggestion.path}\`?` : undefined,
          });
    printError(cliError, { stderr, color });
    return normalizeExitCode(cliError.exitCode);
  }
}

const isMain = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (forwardSignal(signal)) return;
      runCleanup();
      process.exit(EXIT.INTERRUPT);
    });
  void main().then((code) => {
    process.exitCode = code;
  });
}

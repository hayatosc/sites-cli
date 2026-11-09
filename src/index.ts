// CLI entry point: parse arguments, run one command, render the result.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { commandHelp, errorOutputOptions, generalHelp, groupHelp, parseCli } from "./args.ts";
import { createCommands } from "./commands/index.ts";
import { loadAuthIdentity } from "./auth.ts";
import type { Identity } from "./auth.ts";
import { McpClient } from "./mcp.ts";
import { CliError, CommandExit, EXIT, usageError } from "./errors.ts";
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
  const env = options.env ?? (process.env as Env);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const started = Date.now();
  const commands = createCommands();

  let parsed;
  try {
    parsed = parseCli(argv, commands);
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("INTERNAL_ERROR", (error as Error).message, { exitCode: EXIT.GENERAL });
    const outputOptions = errorOutputOptions(argv);
    printError(cliError, {
      json: Boolean(outputOptions.json),
      stderr,
      color: colorEnabled(stderr, outputOptions, env),
    });
    return outputOptions.json || cliError.exitCode === EXIT.INTERRUPT
      ? cliError.exitCode
      : EXIT.GENERAL;
  }

  if (parsed.version) {
    stdout.write("0.1.0\n");
    return EXIT.OK;
  }
  if (parsed.help || !parsed.command) {
    stdout.write(
      parsed.command
        ? commandHelp(parsed.command, env)
        : parsed.helpGroup
          ? groupHelp(parsed.helpGroup, commands, env)
          : generalHelp(commands, env),
    );
    return EXIT.OK;
  }

  const json = !parsed.options.human;
  const envelope = Boolean(parsed.options.json);
  const quiet = Boolean(parsed.options.quiet);
  const color = colorEnabled(stderr, parsed.options, env);
  let identity: Identity | null = null;
  let client: McpClient | null = null;

  const getIdentity = (): Identity => {
    identity ??= loadAuthIdentity(env);
    return identity;
  };

  const ctx: CommandContext = {
    argv,
    command: parsed.command,
    options: parsed.options,
    positionals: parsed.positionals,
    env,
    cwd,
    root: cwd,
    stdout: quiet ? { write: () => {}, isTTY: stdout.isTTY } : stdout,
    stderr: quiet ? { write: () => {}, isTTY: stderr.isTTY } : stderr,
    json,
    quiet: Boolean(parsed.options.quiet),
    yes: Boolean(parsed.options.yes),
    getIdentity,
    log: (text: string) => {
      if (!parsed.options.quiet) stderr.write(text + "\n");
    },
    success: (text: string) => {
      if (!quiet && stderr.isTTY) stderr.write(`✓ ${text}\n`);
    },
    mcp: () => {
      client ??= new McpClient(getIdentity(), { env });
      return client;
    },
  };

  try {
    if (parsed.options.profile)
      throw usageError(
        "USAGE_UNSUPPORTED_FLAG",
        "--profile is not supported: Sites uses shared Codex credentials.",
        { hint: "Remove --profile or select the Codex identity outside this CLI." },
      );
    const result =
      parsed.options["dry-run"] && !parsed.command.nativeDryRun
        ? {
            data: {
              command: `sites ${parsed.command.path.join(" ")}`,
              dryRun: true,
              executed: false,
              validated: "arguments only",
            },
          }
        : await parsed.command.run(ctx);
    const meta: Record<string, unknown> = { duration_ms: Date.now() - started };
    const requestId = (client as McpClient | null)?.requestId;
    if (requestId) meta.request_id = requestId;
    let exitCode = result.exitCode ?? EXIT.OK;
    if (
      !envelope &&
      parsed.command.path[0] !== "dev" &&
      exitCode !== EXIT.OK &&
      exitCode !== EXIT.INTERRUPT
    )
      exitCode = EXIT.GENERAL;
    if (quiet) return exitCode;
    if (result.raw !== undefined) {
      stdout.write(result.raw);
    } else if (envelope) {
      stdout.write(stringifyJson({ ok: true, data: result.data, meta }) + "\n");
    } else if (json) {
      stdout.write(stringifyJson(result.data) + "\n");
    } else if (result.human) {
      result.human(result.data);
    } else {
      stdout.write(stringifyJson(result.data) + "\n");
    }
    return exitCode;
  } catch (error) {
    if (error instanceof CommandExit) return error.exitCode;
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("INTERNAL_ERROR", (error as Error).message ?? String(error), {
            exitCode: EXIT.GENERAL,
          });
    printError(cliError, { json: envelope, stderr, color });
    return envelope || cliError.code === "BUILD_FAILED" || cliError.exitCode === EXIT.INTERRUPT
      ? cliError.exitCode
      : EXIT.GENERAL;
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (forwardSignal(signal)) return;
      runCleanup();
      process.exit(EXIT.INTERRUPT);
    });
  }
  void main().then((code) => {
    process.exitCode = code;
  });
}

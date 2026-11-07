// CLI entry point: parse arguments, run one command, render the result.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { commandHelp, generalHelp, isHumanRequested, parseCli } from "./args.ts";
import { createCommands } from "./commands/index.ts";
import { loadAuthIdentity } from "./auth.ts";
import type { Identity } from "./auth.ts";
import { McpClient } from "./mcp.ts";
import { CliError, EXIT } from "./errors.ts";
import { colorEnabled, printError } from "./output.ts";
import type { CommandContext, Env, OutputStream } from "./types.ts";
import { runCleanup, stringifyJson } from "./util.ts";

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
    const cliError = error instanceof CliError
      ? error
      : new CliError("INTERNAL_ERROR", (error as Error).message, { exitCode: EXIT.GENERAL });
    printError(cliError, {
      json: !isHumanRequested(argv),
      stderr,
      color: colorEnabled(stderr, { "no-color": argv.includes("--no-color") }, env),
    });
    return cliError.exitCode;
  }

  if (parsed.version) {
    stdout.write("0.1.0\n");
    return EXIT.OK;
  }
  if (parsed.help || !parsed.command) {
    stdout.write(parsed.command ? commandHelp(parsed.command) : generalHelp(commands));
    return EXIT.OK;
  }

  const json = !parsed.options.human;
  const color = colorEnabled(stderr, parsed.options, env);
  let identity: Identity | null = null;
  let client: McpClient | null = null;

  const getIdentity = (): Identity => {
    identity ??= loadAuthIdentity(env);
    return identity;
  };

  const ctx: CommandContext = {
    command: parsed.command,
    options: parsed.options,
    positionals: parsed.positionals,
    env,
    cwd,
    root: cwd,
    stdout,
    stderr,
    json,
    quiet: Boolean(parsed.options.quiet),
    yes: Boolean(parsed.options.yes),
    getIdentity,
    log: (text: string) => {
      if (!parsed.options.quiet) stderr.write(text + "\n");
    },
    mcp: () => {
      client ??= new McpClient(getIdentity(), { env });
      return client;
    },
  };

  try {
    const result = await parsed.command.run(ctx);
    const meta: Record<string, unknown> = { duration_ms: Date.now() - started };
    const requestId = (client as McpClient | null)?.requestId;
    if (requestId) meta.request_id = requestId;
    if (json) {
      stdout.write(stringifyJson({ ok: true, data: result.data, meta }) + "\n");
    } else if (result.human) {
      result.human(result.data);
    } else {
      stdout.write(stringifyJson(result.data) + "\n");
    }
    return result.exitCode ?? EXIT.OK;
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError("INTERNAL_ERROR", (error as Error).message ?? String(error), {
          exitCode: EXIT.GENERAL,
        });
    printError(cliError, { json, stderr, color });
    return cliError.exitCode;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      runCleanup();
      process.exit(EXIT.INTERRUPT);
    });
  }
  main().then((code) => {
    process.exitCode = code;
  });
}

// Destructive-action confirmation with cf-compatible force semantics.

import readline from "node:readline";
import { CliError, EXIT } from "./errors.ts";
import type { CommandContext } from "./types.ts";

export async function confirmDestructive(
  ctx: CommandContext,
  label: string,
  force: boolean,
): Promise<boolean> {
  if (force || ctx.yes) return true;
  if (!process.stdin.isTTY) {
    throw new CliError("CONFIRM_REQUIRED", `This permanently deletes ${label}.`, {
      exitCode: EXIT.USAGE,
      hint: "Re-run with --force to confirm in a non-interactive shell.",
    });
  }
  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`? This permanently deletes ${label}. Continue? [y/N] `, (value) => {
      rl.close();
      resolve(value.trim().toLowerCase());
    });
  });
  return answer === "y" || answer === "yes";
}

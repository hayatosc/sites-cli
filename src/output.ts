// Error and result rendering to stdout/stderr (plan §3.1/§3.4).

import { CliError } from "./errors.ts";
import type { Env, OutputStream } from "./types.ts";
import { stringifyJson } from "./util.ts";

export function colorEnabled(
  stream: OutputStream,
  options: Record<string, unknown>,
  env: Env,
): boolean {
  if (options["no-color"] || env.NO_COLOR) return false;
  return Boolean(stream.isTTY);
}

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export interface ErrorRenderOptions {
  json: boolean;
  stderr: OutputStream;
  color?: boolean;
}

export function printError(
  error: CliError,
  { json, stderr, color = false }: ErrorRenderOptions,
): void {
  const details: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.hint) details.hint = error.hint;
  if (error.docs) details.docs = error.docs;
  if (error.details !== undefined) details.details = error.details;

  if (json) {
    stderr.write(stringifyJson({ ok: false, error: details }) + "\n");
    return;
  }
  stderr.write(paint("Error: ", "31;1", color) + error.message + "\n");
  if (error.hint) stderr.write(`  hint: ${error.hint}\n`);
  if (error.docs) stderr.write(`  docs: ${error.docs}\n`);
}

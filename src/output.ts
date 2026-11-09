// Error and result rendering to stdout/stderr (plan §3.1/§3.4).

import { CliError } from "./errors.ts";
import { createStyle, padEndVisible, visibleWidth } from "./style.ts";
import type { Env, OutputStream } from "./types.ts";

export function colorEnabled(
  stream: OutputStream,
  options: Record<string, unknown>,
  env: Env,
): boolean {
  if (options["no-color"] || env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return Boolean(stream.isTTY);
}

export function renderTable(stream: OutputStream, header: string[], rows: string[][]): void {
  const widths = header.map((cell, index) =>
    Math.max(visibleWidth(cell), ...rows.map((row) => visibleWidth(row[index]))),
  );
  const render = (row: string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : padEndVisible(cell, widths[index])))
      .join("  ")
      .trimEnd();
  stream.write([render(header), ...rows.map(render)].join("\n") + "\n");
}

export interface ErrorRenderOptions {
  stderr: OutputStream;
  color?: boolean;
}

export function printError(error: CliError, { stderr, color = false }: ErrorRenderOptions): void {
  const style = createStyle(color);
  stderr.write(style.error("Error: ") + error.message + "\n");
  if (error.hint) stderr.write(`  ${style.label("hint:")} ${error.hint}\n`);
  if (error.docs) stderr.write(`  ${style.label("docs:")} ${style.url(error.docs)}\n`);
}

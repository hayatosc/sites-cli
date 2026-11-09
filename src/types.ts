// Shared types for the command layer.

import type { Identity } from "./auth.ts";
import type { McpClient } from "./mcp.ts";

export type Env = Record<string, string | undefined>;

/** Minimal writable stream surface, so tests can capture output. */
export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface CommandResult<T = unknown> {
  data: T;
  // Method syntax keeps the callback bivariant so concrete results can be
  // registered as an erased CommandDefinition.
  human?(data: T): void;
  /** Writes raw stdout instead of the JSON envelope (e.g. `open --print`). */
  raw?: string;
  /** Overrides the process exit code for successful (non-throwing) results. */
  exitCode?: number;
}

export interface CommandDefinition<T = unknown> {
  path: string[];
  flags?: string[];
  /** Native previews may build locally; other commands only preview parsed arguments. */
  nativeDryRun?: boolean;
  /** Delegate unknown flags verbatim (e.g. a project's dev server). */
  forwardArgs?: boolean;
  hidden?: boolean;
  positionals?: { min: number; max: number; names?: string[] };
  summary?: string;
  keywords?: string[];
  usage?: string;
  run: (ctx: CommandContext) => Promise<CommandResult<T>>;
}

export type DefineCommand = <T>(command: CommandDefinition<T>) => void;

export interface ResolvedCommand extends CommandDefinition {
  /** Indexes in argv occupied by the command words. */
  consumedIndexes: number[];
}

export interface ParsedCli {
  command?: ResolvedCommand;
  options: Record<string, unknown>;
  positionals: string[];
  help: boolean;
  version: boolean;
  /** Set when `<group> --help` was requested. */
  helpGroup?: string;
}

export interface CommandContext {
  argv: readonly string[];
  command: CommandDefinition;
  options: Record<string, unknown>;
  positionals: string[];
  env: Env;
  cwd: string;
  root: string;
  stdout: OutputStream;
  stderr: OutputStream;
  json: boolean;
  quiet: boolean;
  yes: boolean;
  /** Resolves (and caches) Codex credentials. */
  getIdentity: () => Identity;
  log: (text: string) => void;
  /** Writes a cf-style success line only to an interactive, non-quiet stderr. */
  success: (text: string) => void;
  /** Lazily creates the MCP client. */
  mcp: () => McpClient;
}

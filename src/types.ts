// Shared types for the command layer.

import type { Command } from "gunshi";
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
  /** Writes raw stdout instead of JSON (e.g. `open --print`). */
  raw?: string;
  /** Overrides the process exit code for successful (non-throwing) results. */
  exitCode?: number;
}

export interface CommandDefinition<T = unknown> {
  /** Native definition shared by execution, help and discovery. */
  gunshi?: Command;
  path: string[];
  flags?: string[];
  /** Native previews may build locally; other commands only preview parsed arguments. */
  nativeDryRun?: boolean;
  hidden?: boolean;
  positionals?: { min: number; max: number; names?: string[] };
  summary?: string;
  keywords?: string[];
  usage?: string;
  run: (ctx: CommandContext) => Promise<CommandResult<T>>;
}

export type DefineCommand = <T>(command: CommandDefinition<T>) => void;

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
  /** Resolves (and caches) Codex credentials. */
  getIdentity: () => Identity;
  /** Writes a progress step to stderr. */
  log: (text: string) => void;
  /** Writes secondary progress details to stderr. */
  detail: (text: string) => void;
  /** Writes a success line to interactive or human-mode, non-quiet stderr. */
  success: (text: string) => void;
  /** Lazily creates the MCP client. */
  mcp: () => McpClient;
}

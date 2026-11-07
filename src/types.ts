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
}

export interface CommandDefinition<T = unknown> {
  path: string[];
  flags?: string[];
  positionals?: { min: number; max: number; names?: string[] };
  summary?: string;
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
}

export interface CommandContext {
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
  /** Lazily creates the MCP client. */
  mcp: () => McpClient;
}

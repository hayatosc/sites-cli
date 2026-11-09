// Internal diagnostic identifiers and cf-compatible process exit status.

export const EXIT = {
  OK: 0,
  GENERAL: 1,
  USAGE: 1,
  AUTH: 1,
  NETWORK: 1,
  PREFLIGHT: 1,
  CONFLICT: 1,
  INTERRUPT: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function normalizeExitCode(code: number): ExitCode {
  return code === EXIT.OK ? EXIT.OK : code === EXIT.INTERRUPT ? EXIT.INTERRUPT : EXIT.GENERAL;
}

export interface CliErrorOptions {
  exitCode?: number;
  hint?: string;
  docs?: string;
  details?: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;
  readonly docs?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.GENERAL;
    this.hint = options.hint;
    this.docs = options.docs;
    this.details = options.details;
  }
}

/** Stop a delegated command without printing an error or running later effects. */
export class CommandExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`Command exited with code ${exitCode}.`);
    this.exitCode = exitCode;
  }
}

export function usageError(code: string, message: string, options: CliErrorOptions = {}): CliError {
  return new CliError(code, message, { exitCode: EXIT.USAGE, ...options });
}

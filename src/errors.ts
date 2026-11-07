// Machine-readable error codes and process exit codes (plan §3.3/§3.4).

export const EXIT = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  PREFLIGHT: 5,
  CONFLICT: 6,
  INTERRUPT: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

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

export function usageError(code: string, message: string, options: CliErrorOptions = {}): CliError {
  return new CliError(code, message, { exitCode: EXIT.USAGE, ...options });
}

// Small shared helpers.

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Env } from "./types.ts";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function homeDir(env: Env): string {
  return env.HOME || os.homedir();
}

export function displayPath(target: string, home = homeDir(process.env as Env)): string {
  if (!target) return target;
  return target.startsWith(home + path.sep) ? "~" + target.slice(home.length) : target;
}

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatJst(iso: string | null | undefined): string {
  if (!iso) return "不明";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const parts = jstFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

export function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

export function redact(text: unknown, secrets: Array<string | null | undefined>): string {
  let out = typeof text === "string" ? text : textValue(text) || (JSON.stringify(text) ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function stringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(options: Record<string, unknown>, name: string): boolean {
  return options[name] === true;
}

export function stringListOption(options: Record<string, unknown>, name: string): string[] {
  const value = options[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseIntegerOption(
  raw: string | undefined,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  return value;
}

const cleanupHandlers: Array<() => void> = [];

/** Registers a best-effort cleanup callback (temp files) for SIGINT/SIGTERM. */
export function registerCleanup(handler: () => void): void {
  cleanupHandlers.push(handler);
}

export function runCleanup(): void {
  for (const handler of cleanupHandlers.splice(0)) {
    try {
      handler();
    } catch {
      // Cleanup is best-effort.
    }
  }
}

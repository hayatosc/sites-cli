// Shared semantic palette for human-readable terminal output.

import { stripVTControlCharacters } from "node:util";

export function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

export function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function createStyle(enabled: boolean) {
  const paint =
    (code: string) =>
    (text: string): string =>
      enabled && text.length > 0 ? `\u001b[${code}m${text}\u001b[0m` : text;
  const value = (text: string): string => text;
  const success = paint("32");
  const warn = paint("33");
  const error = paint("31;1");
  const dim = paint("2");
  return {
    heading: paint("36"),
    label: paint("1"),
    value,
    dim,
    id: dim,
    success,
    ok: success,
    warn,
    error,
    url: paint("36;4"),
    status: (text: string): string => {
      switch (text.toLowerCase()) {
        case "live":
        case "ready":
        case "success":
        case "succeeded":
        case "ok":
        case "active":
        case "active_redeploying":
          return success(text);
        case "pending":
        case "building":
        case "waiting":
        case "warn":
        case "warning":
        case "pending_validation":
        case "pending_dns":
        case "pending_certificate":
        case "initializing":
        case "publishing":
          return warn(text);
        case "failed":
        case "error":
        case "deleted":
        case "fail":
        case "fatal":
        case "blocked":
        case "expired":
          return error(text);
        default:
          return value(text);
      }
    },
  };
}

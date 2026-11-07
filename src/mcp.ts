// Minimal MCP client for https://chatgpt.com/backend-api/ps/mcp (plan §6.1).

import { CliError, EXIT } from "./errors.ts";
import type { Identity } from "./auth.ts";
import { ensureFresh } from "./auth.ts";
import type { Env } from "./types.ts";
import { redact, sleep } from "./util.ts";

export const DEFAULT_MCP_URL = "https://chatgpt.com/backend-api/ps/mcp";
export const VERSION = "0.1.0";
const USER_AGENT = `codex_cli_rs/${VERSION} (Linux; x86_64) rust`;

interface ToolContentItem {
  type?: string;
  text?: string;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: ToolContentItem[];
}

interface ParsedBody {
  json?: unknown;
  events?: unknown[];
  raw?: string;
}

export interface McpClientOptions {
  url?: string;
  env?: Env;
  retries?: number;
  timeoutMs?: number;
  retryBaseMs?: number;
}

/** Parses SSE `data:` lines into individual message payloads. */
export function parseSse(text: string): string[] {
  const messages: string[] = [];
  let dataLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      if (dataLines.length) {
        messages.push(dataLines.join("\n"));
        dataLines = [];
      }
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length) messages.push(dataLines.join("\n"));
  return messages;
}

function parseMcpBody(text: string, contentType: string | null): ParsedBody {
  const trimmed = text.trim();
  if (!trimmed) return { json: null };
  const looksLikeSse = (contentType ?? "").includes("text/event-stream") || /^(event|data):/.test(trimmed);
  if (!looksLikeSse) {
    try {
      return { json: JSON.parse(trimmed) };
    } catch {
      return { raw: text };
    }
  }
  const events: unknown[] = [];
  for (const message of parseSse(text)) {
    try {
      events.push(JSON.parse(message));
    } catch {
      // Ignore malformed SSE events.
    }
  }
  return { json: events.length === 1 ? events[0] : events, events };
}

function errorFromToolResult(result: ToolResult, toolName: string): CliError {
  const structured = result.structuredContent ?? {};
  const textItem = (result.content ?? []).find((item) => item?.type === "text");
  const rawMessage = structured.error ?? textItem?.text ?? `Tool ${toolName} failed`;
  const message = String(rawMessage).replace(/^SitesConnectorError:\s*/, "");
  const errorCode = String(structured.error_code ?? "TOOL_ERROR");
  const errorData = (structured.error_data ?? {}) as { type?: string; code?: number };

  let exitCode: number = EXIT.GENERAL;
  let code = errorCode;
  if (errorCode === "CONFLICT" || errorData.type === "site_not_owner_only") {
    exitCode = EXIT.CONFLICT;
    code = errorData.type === "site_not_owner_only" ? "CONFLICT_SITE_NOT_OWNER_ONLY" : "CONFLICT";
  } else if (errorCode === "INVALID_ARGUMENT") {
    exitCode = EXIT.USAGE;
  } else if (errorCode === "NOT_FOUND") {
    exitCode = EXIT.PREFLIGHT;
  } else if (errorCode === "UNAUTHENTICATED" || errorCode === "UNAUTHORIZED" || errorData.code === 401) {
    exitCode = EXIT.AUTH;
    code = "AUTH_UNAUTHORIZED";
  } else if (errorCode === "RATE_LIMITED" || errorCode === "INTERNAL") {
    exitCode = EXIT.NETWORK;
  }

  return new CliError(code, message, {
    exitCode,
    details: {
      tool: toolName,
      error_code: errorCode,
      ...(errorData.type ? { type: errorData.type } : {}),
    },
  });
}

function unwrapToolResult(result: ToolResult | undefined): unknown {
  if (result?.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const textItem = (result?.content ?? []).find((item) => item?.type === "text");
  if (textItem?.text) {
    try {
      return JSON.parse(textItem.text);
    } catch {
      return textItem.text;
    }
  }
  return {};
}

function isNetworkRetryable(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  return (
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code ?? "") ||
    (error as Error).name === "TimeoutError"
  );
}

export class McpClient {
  private readonly identity: Identity;
  private readonly url: string;
  private readonly env: Env;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;
  private nextId = 1;
  requestId: string | null = null;

  constructor(identity: Identity, options: McpClientOptions = {}) {
    this.identity = identity;
    this.env = options.env ?? (process.env as Env);
    this.url = options.url ?? this.env.SITES_MCP_URL ?? DEFAULT_MCP_URL;
    this.retries = options.retries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.retryBaseMs = options.retryBaseMs ?? Number(this.env.SITES_RETRY_BASE_MS ?? 500);
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-OpenAI-Product-Sku": "codex",
      originator: "codex_cli_rs",
      "User-Agent": USER_AGENT,
    };
  }

  private async post(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    let authRetried = false;
    let forceRefresh = false;

    for (let attempt = 0; ; attempt += 1) {
      const identity = await ensureFresh(this.identity, { force: forceRefresh, env: this.env });
      forceRefresh = false;

      let response: Response;
      try {
        response = await fetch(this.url, {
          method: "POST",
          headers: this.headers(identity.token),
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.retries && isNetworkRetryable(error)) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw new CliError("NETWORK_ERROR", `Could not reach the Sites API: ${(error as Error).message}`, {
          exitCode: EXIT.NETWORK,
          hint: "Check the network connection and retry.",
        });
      }

      this.requestId = response.headers.get("x-request-id") ?? this.requestId;

      if (response.status === 401 && !authRetried) {
        await response.text().catch(() => "");
        authRetried = true;
        forceRefresh = true;
        attempt -= 1;
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await response.text().catch(() => "");
        if (attempt < this.retries) {
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.retryBaseMs * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        throw new CliError(
          response.status === 429 ? "RATE_LIMITED" : "SERVER_ERROR",
          `Sites API returned HTTP ${response.status} after ${this.retries} retries.`,
          {
            exitCode: EXIT.NETWORK,
            hint: response.status === 429
              ? "Wait a moment and retry."
              : "Retry later; the service may be temporarily unavailable.",
          },
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const authFailure = response.status === 401 || response.status === 403;
        throw new CliError(authFailure ? "AUTH_UNAUTHORIZED" : "HTTP_ERROR", `Sites API returned HTTP ${response.status}.`, {
          exitCode: authFailure ? EXIT.AUTH : EXIT.NETWORK,
          details: text ? { body: redact(text, [identity.token]).slice(0, 1000) } : undefined,
        });
      }

      const text = await response.text();
      const parsed = parseMcpBody(text, response.headers.get("content-type"));
      let message = parsed.json as Record<string, unknown> | null;
      if (Array.isArray(parsed.events)) {
        const events = parsed.events as Array<Record<string, unknown>>;
        message = events.find((event) => event?.id === id) ?? events[events.length - 1] ?? null;
      }
      if (!message || typeof message !== "object") {
        throw new CliError("INVALID_RESPONSE", "The Sites API returned an unreadable response.", {
          exitCode: EXIT.NETWORK,
        });
      }
      if (message.error) {
        const rpcError = message.error as { message?: string; code?: number };
        throw new CliError("MCP_ERROR", rpcError.message ?? "The Sites API returned a JSON-RPC error.", {
          exitCode: EXIT.NETWORK,
          details: { jsonrpc_code: rpcError.code },
        });
      }
      return message.result;
    }
  }

  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }> {
    const result = (await this.post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sites-cli", version: VERSION },
    })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } | undefined;

    const serverInfo = result?.serverInfo;
    if (serverInfo && serverInfo.name !== "plugin-runtime") {
      throw new CliError("AUTH_SERVER_MISMATCH", `Unexpected MCP server: ${serverInfo.name ?? "unknown"}`, {
        exitCode: EXIT.NETWORK,
        hint: "The Sites endpoint may have changed; check for a CLI update.",
      });
    }
    return { protocolVersion: result?.protocolVersion, serverInfo };
  }

  async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.post("tools/call", { name, arguments: args })) as ToolResult | undefined;
    if (result?.isError) throw errorFromToolResult(result, name);
    return unwrapToolResult(result) as T;
  }
}

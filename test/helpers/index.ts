// Test helpers: an in-process mock MCP server and a CLI runner.

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/index.ts";
import type { Env, OutputStream } from "../../src/types.ts";

export interface MockCall {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export interface MockResponse {
  result?: unknown;
  status?: number;
  body?: string;
  sse?: boolean;
  headers?: Record<string, string>;
}

export type MockHandler = (
  call: MockCall,
  index: number,
) => MockResponse | undefined | Promise<MockResponse | undefined>;

export interface MockMcp {
  url: string;
  calls: MockCall[];
  close: () => Promise<void>;
}

export async function createMockMcp(
  handler?: MockHandler,
  options: { sseDefault?: boolean } = {},
): Promise<MockMcp> {
  const calls: MockCall[] = [];
  const sseDefault = options.sseDefault ?? true;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let payload: {
      id?: number | string;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    } = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Leave payload empty for malformed requests.
    }
    const call: MockCall = {
      method: payload.method ?? "",
      name: payload.params?.name,
      args: payload.params?.arguments,
      headers: req.headers,
    };
    calls.push(call);
    const index = calls.length - 1;

    let response = await handler?.(call, index);
    if (!response) {
      response =
        payload.method === "initialize"
          ? {
              result: {
                protocolVersion: "2025-03-26",
                serverInfo: { name: "plugin-runtime", version: "0.1.0" },
              },
            }
          : { result: { structuredContent: {}, content: [] } };
    }
    if (response.status && response.status !== 200) {
      res.writeHead(response.status, response.headers ?? {});
      res.end(response.body ?? "");
      return;
    }
    if (response.body !== undefined) {
      res.writeHead(200, { "content-type": "text/plain", ...response.headers });
      res.end(response.body);
      return;
    }
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: response.result ?? {},
    });
    if (response.sse ?? sseDefault) {
      res.writeHead(200, { "content-type": "text/event-stream", ...response.headers });
      res.end(`event: message\ndata: ${message}\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json", ...response.headers });
      res.end(message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/backend-api/ps/mcp`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export class Collector implements OutputStream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  out: Collector;
  err: Collector;
}

export async function runCli(
  args: string[],
  options: { env?: Env; cwd?: string; tty?: boolean; defaultOutput?: boolean } = {},
): Promise<RunResult> {
  const base: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SITES_") && key !== "NO_COLOR") base[key] = value;
  }
  const env: Env = {
    ...base,
    SITES_ACCESS_TOKEN: "test-token",
    NO_COLOR: "1",
    ...options.env,
  };
  const out = new Collector();
  const err = new Collector();
  out.isTTY = options.tty ?? false;
  err.isTTY = options.tty ?? false;
  const code = await main(args, {
    env,
    cwd: options.cwd ?? process.cwd(),
    stdout: out,
    stderr: err,
  });
  return { code, stdout: out.text, stderr: err.text, out, err };
}

export function tempDir(prefix = "sites-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fakeJwt(expMs: number, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), ...extra })).toString(
    "base64url",
  );
  return `${header}.${payload}.signature`;
}

export interface MockAuth {
  url: string;
  requests: Array<Record<string, string>>;
  close: () => Promise<void>;
}

export async function createMockAuth(
  respond: (body: URLSearchParams) => { status?: number; json: Record<string, unknown> },
): Promise<MockAuth> {
  const requests: Array<Record<string, string>> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    requests.push(Object.fromEntries(body.entries()));
    const result = respond(body);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/oauth/token`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function writeAuthFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

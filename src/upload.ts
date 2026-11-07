// Three-stage file upload (plan §5.1).

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import type { UploadedArchive } from "./api-types.ts";
import type { Env } from "./types.ts";
import { sleep } from "./util.ts";

interface UploadSession {
  file_id: string;
  upload_url: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function apiBase(env: Env): string {
  return (env.SITES_API_BASE || "https://chatgpt.com").replace(/\/$/, "");
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new CliError("NETWORK_ERROR", `Upload request failed: ${(error as Error).message}`, {
      exitCode: EXIT.NETWORK,
    });
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!(error instanceof Retryable) || attempt === 2) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

class Retryable extends Error {}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (RETRYABLE.has(response.status)) throw new Retryable(`HTTP ${response.status}`);
    if (response.status === 401) {
      throw new CliError("AUTH_UNAUTHORIZED", "The upload endpoint rejected the access token.", {
        exitCode: EXIT.AUTH,
      });
    }
    throw new CliError("UPLOAD_FAILED", `Upload request failed with HTTP ${response.status}.`, {
      exitCode: EXIT.NETWORK,
      details: { body: text.slice(0, 500) },
    });
  }
  return (await response.json()) as T;
}

export async function uploadArchive(options: {
  archiveFile: string;
  projectId: string;
  token: string;
  env: Env;
  log?: (text: string) => void;
}): Promise<UploadedArchive> {
  const stat = fs.statSync(options.archiveFile);
  const fileName = path.basename(options.archiveFile);
  const headers = {
    authorization: `Bearer ${options.token}`,
    "x-openai-product-sku": "codex",
  };

  const session = await withRetry(() =>
    postJson<UploadSession>(
      `${apiBase(options.env)}/backend-api/files`,
      {
        file_name: fileName,
        file_size: stat.size,
        use_case: "codex",
        codex_connector_id: options.projectId,
        codex_action_name: "sites_deploy",
        codex_model: "codex",
      },
      headers,
    ),
  );

  const body = fs.readFileSync(options.archiveFile);
  const put = await request(session.upload_url, {
    method: "PUT",
    headers: {
      "content-type": "application/gzip",
      "x-ms-blob-type": "BlockBlob",
      "content-length": String(body.length),
    },
    body,
  });
  if (!put.ok) {
    throw new CliError("UPLOAD_FAILED", `Blob upload failed with HTTP ${put.status}.`, {
      exitCode: EXIT.NETWORK,
    });
  }

  const deadline = Date.now() + 30_000;
  const pollMs = Number(options.env.SITES_UPLOAD_POLL_MS || 250);
  let delay = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 250;
  for (;;) {
    const result = await withRetry(() =>
      postJson<{
        status?: string;
        download_url?: string;
        mime_type?: string;
        file_name?: string;
        file_size_bytes?: number;
      }>(
        `${apiBase(options.env)}/backend-api/files/${encodeURIComponent(session.file_id)}/uploaded`,
        {},
        headers,
      ),
    );
    if (result.status === "success" && result.download_url) {
      return {
        download_url: result.download_url,
        file_id: session.file_id,
        mime_type: result.mime_type || "application/gzip",
        file_name: result.file_name || fileName,
        file_size_bytes: result.file_size_bytes ?? stat.size,
      };
    }
    if (Date.now() >= deadline) {
      throw new CliError("UPLOAD_TIMEOUT", "The archive upload did not finish in time.", {
        exitCode: EXIT.NETWORK,
        hint: "Retry the deploy.",
      });
    }
    options.log?.("waiting for archive upload");
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

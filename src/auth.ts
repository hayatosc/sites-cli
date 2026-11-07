// Authentication: reuse Codex CLI credentials and refresh them atomically.
// See plan §2.1.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CliError, EXIT } from "./errors.ts";
import type { Env } from "./types.ts";
import { displayPath, homeDir, redact } from "./util.ts";

const REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_SKEW_MS = 60_000;

export interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
    [key: string]: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface Identity {
  token: string;
  source: string;
  expiresAt: number | null;
  accountId: string | null;
  refreshToken: string | null;
  refreshTokenPresent: boolean;
  /** null when the token comes from SITES_ACCESS_TOKEN. */
  path: string | null;
  raw?: AuthFile;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export function authFilePath(env: Env): string {
  return env.SITES_AUTH_PATH || path.join(homeDir(env), ".codex", "auth.json");
}

export function decodeJwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function loadAuthIdentity(env: Env): Identity {
  if (env.SITES_ACCESS_TOKEN) {
    return {
      token: env.SITES_ACCESS_TOKEN,
      source: "SITES_ACCESS_TOKEN",
      expiresAt: decodeJwtExpiry(env.SITES_ACCESS_TOKEN),
      accountId: null,
      refreshToken: null,
      refreshTokenPresent: false,
      path: null,
    };
  }

  const file = authFilePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError(
        "AUTH_NOT_FOUND",
        `Codex credentials not found at ${displayPath(file, homeDir(env))}`,
        {
          exitCode: EXIT.AUTH,
          hint: "Run `codex login` to sign in, then retry.",
        },
      );
    }
    throw new CliError(
      "AUTH_READ_FAILED",
      `Could not read ${displayPath(file, homeDir(env))}: ${(error as Error).message}`,
      {
        exitCode: EXIT.AUTH,
      },
    );
  }

  let parsed: AuthFile;
  try {
    parsed = JSON.parse(raw) as AuthFile;
  } catch {
    throw new CliError(
      "AUTH_INVALID",
      `Invalid Codex credentials at ${displayPath(file, homeDir(env))}`,
      {
        exitCode: EXIT.AUTH,
        hint: "Run `codex login` again.",
      },
    );
  }

  const tokens = parsed.tokens ?? {};
  if (!tokens.access_token) {
    throw new CliError("AUTH_NOT_FOUND", `No access token in ${displayPath(file, homeDir(env))}`, {
      exitCode: EXIT.AUTH,
      hint: "Run `codex login` to sign in, then retry.",
    });
  }

  return {
    token: tokens.access_token,
    source: displayPath(file, homeDir(env)),
    expiresAt: decodeJwtExpiry(tokens.access_token),
    accountId: tokens.account_id ?? null,
    refreshToken: tokens.refresh_token ?? null,
    refreshTokenPresent: Boolean(tokens.refresh_token),
    path: file,
    raw: parsed,
  };
}

export function isExpired(identity: Identity, skewMs = EXPIRY_SKEW_MS): boolean {
  return Boolean(identity.expiresAt && identity.expiresAt - Date.now() < skewMs);
}

/** Writes the refreshed token back atomically (mode 0600, temp file + rename). */
function writeAuthFile(identity: Identity, response: RefreshResponse): void {
  const target = identity.path;
  if (!target) return;
  const current = identity.raw ?? (JSON.parse(fs.readFileSync(target, "utf8")) as AuthFile);
  const tokens = { ...current.tokens };
  tokens.access_token = response.access_token;
  if (response.refresh_token) tokens.refresh_token = response.refresh_token;
  if (response.id_token) tokens.id_token = response.id_token;
  const next: AuthFile = {
    ...current,
    tokens,
    last_refresh: new Date().toISOString(),
  };

  const tmp = path.join(
    path.dirname(target),
    `.auth.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; the rename error is the one to report.
    }
    throw error;
  }
  identity.raw = next;
}

export async function refreshIdentity(
  identity: Identity,
  env: Env = process.env as Env,
): Promise<Identity> {
  if (!identity.refreshToken) {
    throw new CliError(
      "AUTH_REFRESH_UNAVAILABLE",
      "The Codex access token has expired and no refresh token is available.",
      {
        exitCode: EXIT.AUTH,
        hint: "Run `codex login` to sign in again.",
      },
    );
  }

  const url = env.SITES_AUTH_URL || "https://auth.openai.com/oauth/token";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: identity.refreshToken,
        client_id: REFRESH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new CliError(
      "AUTH_REFRESH_FAILED",
      `Could not refresh the Codex token: ${(error as Error).message}`,
      {
        exitCode: EXIT.AUTH,
        hint: "Check the network connection and run `codex login` if the problem persists.",
      },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CliError("AUTH_REFRESH_FAILED", `Token refresh failed (HTTP ${response.status}).`, {
      exitCode: EXIT.AUTH,
      hint: "Run `codex login` to sign in again.",
      details: body ? { body: redact(body, [identity.refreshToken]).slice(0, 500) } : undefined,
    });
  }

  const tokenResponse = (await response.json()) as RefreshResponse;
  if (!tokenResponse.access_token) {
    throw new CliError("AUTH_REFRESH_FAILED", "Token refresh returned no access token.", {
      exitCode: EXIT.AUTH,
      hint: "Run `codex login` to sign in again.",
    });
  }

  writeAuthFile(identity, tokenResponse);
  identity.token = tokenResponse.access_token;
  identity.expiresAt = decodeJwtExpiry(tokenResponse.access_token);
  if (tokenResponse.refresh_token) {
    identity.refreshToken = tokenResponse.refresh_token;
    identity.refreshTokenPresent = true;
  }
  return identity;
}

/** Refreshes when expired, or unconditionally with `force`. */
export async function ensureFresh(
  identity: Identity,
  { force = false, env }: { force?: boolean; env?: Env } = {},
): Promise<Identity> {
  if (!identity.path) {
    if (isExpired(identity)) {
      throw new CliError(
        "AUTH_EXPIRED",
        "The Codex access token has expired and cannot be refreshed.",
        {
          exitCode: EXIT.AUTH,
          hint: "Run `codex login` to sign in again, or set a fresh SITES_ACCESS_TOKEN.",
        },
      );
    }
    return identity;
  }
  if (force || isExpired(identity)) {
    if (!identity.refreshToken) {
      if (isExpired(identity)) {
        throw new CliError("AUTH_EXPIRED", "The Codex access token has expired.", {
          exitCode: EXIT.AUTH,
          hint: "Run `codex login` to sign in again.",
        });
      }
      return identity;
    }
    await refreshIdentity(identity, env);
  }
  return identity;
}

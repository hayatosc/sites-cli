// `sites auth whoami` (plan §4).
//
// The shape follows the cf CLI: an unauthenticated invocation is a successful
// result that reports `authenticated: false`, rather than an error.

import { isExpired } from "../auth.ts";
import type { Identity } from "../auth.ts";
import { CliError } from "../errors.ts";
import type { CommandResult, DefineCommand } from "../types.ts";
import { displayPath, formatJst } from "../util.ts";

interface WhoamiData {
  authenticated: boolean;
  authSource: string;
  tokenValid: boolean;
  accountId: string | null;
  expiresAt: string | null;
  refreshTokenPresent: boolean;
  error?: string;
  server?: { name?: string; version?: string };
}

function authSource(identity: Identity): string {
  if (identity.source === "SITES_ACCESS_TOKEN") return "SITES_ACCESS_TOKEN";
  return `Codex auth file (${identity.path ? displayPath(identity.path) : identity.source})`;
}

function describe(identity: Identity): WhoamiData {
  return {
    authenticated: true,
    authSource: authSource(identity),
    tokenValid: !isExpired(identity, 0),
    accountId: identity.accountId,
    expiresAt: identity.expiresAt ? new Date(identity.expiresAt).toISOString() : null,
    refreshTokenPresent: identity.refreshTokenPresent,
  };
}

export function registerAuthCommands(define: DefineCommand): void {
  define({
    path: ["auth", "whoami"],
    flags: ["check"],
    positionals: { min: 0, max: 0 },
    summary: "Show the authentication source and status",
    usage: "sites auth whoami [--check]",
    run: async (ctx): Promise<CommandResult<WhoamiData>> => {
      let identity: Identity;
      try {
        identity = ctx.getIdentity();
      } catch (error) {
        if (ctx.options.check || !(error instanceof CliError) || !error.code.startsWith("AUTH_")) {
          throw error;
        }
        const data: WhoamiData = {
          authenticated: false,
          authSource: "none",
          tokenValid: false,
          accountId: null,
          expiresAt: null,
          refreshTokenPresent: false,
          error: "Not logged in",
        };
        return {
          data,
          human: (value) => {
            ctx.stdout.write(`${value.error}\n`);
            ctx.stdout.write("Run `codex login` to sign in.\n");
          },
        };
      }

      const data = describe(identity);
      if (ctx.options.check) {
        const { serverInfo } = await ctx.mcp().initialize();
        data.server = { name: serverInfo?.name, version: serverInfo?.version };
      }
      return {
        data,
        human: (value) => {
          if (!value.authenticated) {
            ctx.stdout.write(`${value.error}\n`);
            return;
          }
          const lines = [
            `Authenticated: ${value.tokenValid ? "yes" : "no (expired)"}`,
            `Auth source: ${value.authSource}`,
            `Account: ${value.accountId ?? "unknown"}`,
            `Expires: ${formatJst(value.expiresAt)}`,
          ];
          if (value.server) lines.push(`Server: ${value.server.name} ${value.server.version}`);
          ctx.stdout.write(lines.join("\n") + "\n");
        },
      };
    },
  });
}

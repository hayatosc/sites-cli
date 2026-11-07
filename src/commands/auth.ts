// `sites auth whoami` (plan §4).

import type { CommandResult, DefineCommand } from "../types.ts";
import { formatJst } from "../util.ts";

interface WhoamiData {
  source: string;
  account_id: string | null;
  expires_at: string | null;
  refresh_token_present: boolean;
  server?: { name?: string; version?: string };
}

export function registerAuthCommands(define: DefineCommand): void {
  define({
    path: ["auth", "whoami"],
    flags: ["check"],
    positionals: { min: 0, max: 0 },
    summary: "Show the authentication source and status",
    usage: "sites auth whoami [--check]",
    run: async (ctx): Promise<CommandResult<WhoamiData>> => {
      const identity = ctx.getIdentity();
      const data: WhoamiData = {
        source: identity.source,
        account_id: identity.accountId,
        expires_at: identity.expiresAt ? new Date(identity.expiresAt).toISOString() : null,
        refresh_token_present: identity.refreshTokenPresent,
      };
      if (ctx.options.check) {
        const { serverInfo } = await ctx.mcp().initialize();
        data.server = { name: serverInfo?.name, version: serverInfo?.version };
      }
      return {
        data,
        human: (value) => {
          const shared = value.source.includes("auth.json") ? "（Codex CLI と共通）" : "";
          const lines = [`認証: ${value.source}${shared}`, `有効期限: ${formatJst(value.expires_at)}`];
          if (value.server) lines.push(`サーバ: ${value.server.name} ${value.server.version}`);
          ctx.stdout.write(lines.join("\n") + "\n");
        },
      };
    },
  });
}

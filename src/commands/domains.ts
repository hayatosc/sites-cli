// `sites domains` (plan §4).

import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type { CustomDomainRecord, ListCustomDomainsResult } from "../api-types.ts";
import { resolveProjectRef } from "../manifest.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { integerOption } from "../args.ts";
import { sleep, textValue } from "../util.ts";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface ValidationRecord {
  record_type?: string;
  name?: string;
  value?: string;
}

interface DomainData {
  project_id: string;
  domain: Record<string, unknown>;
  dns: {
    cname_target: string | null;
    apex_ipv4_targets: string[];
    validation_records: ValidationRecord[];
  } | null;
}

interface DomainListData {
  project_id: string;
  items: CustomDomainRecord[];
}

function validateHostname(raw: string | undefined): string {
  if (!raw) {
    throw usageError("USAGE_MISSING_ARGUMENT", "Pass a hostname.", {
      hint: "Example: sites domains add www.example.com",
    });
  }
  const hostname = raw.toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new CliError("USAGE_INVALID_HOSTNAME", `Invalid hostname: ${raw}`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Use a lowercase DNS name such as www.example.com.",
    });
  }
  return hostname;
}

async function resolveDomain(
  ctx: CommandContext,
  projectId: string,
  ref: string | undefined,
): Promise<CustomDomainRecord> {
  if (!ref) {
    throw usageError("USAGE_MISSING_ARGUMENT", "Pass a hostname or custom_domain_id.");
  }
  const listed = await ctx.mcp().callTool<ListCustomDomainsResult>("sites.list_custom_domains", {
    project_id: projectId,
  });
  const items = listed.items ?? [];
  const match = items.find((item) => item.id === ref || item.hostname === ref.toLowerCase());
  if (!match?.id) {
    throw new CliError("NOT_FOUND_DOMAIN", `Custom domain not found: ${ref}`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run `sites domains list` to see configured domains.",
    });
  }
  return match;
}

function domainData(projectId: string, domain: CustomDomainRecord): DomainData {
  const raw = domain as Record<string, unknown>;
  const records = Array.isArray(raw.validation_records)
    ? (raw.validation_records as ValidationRecord[])
    : [];
  return {
    project_id: projectId,
    domain: raw,
    dns: {
      cname_target: (raw.cname_target as string | undefined) ?? null,
      apex_ipv4_targets: Array.isArray(raw.apex_proxy_ipv4_targets)
        ? (raw.apex_proxy_ipv4_targets as string[])
        : [],
      validation_records: records,
    },
  };
}

function renderDomainInstructions(ctx: CommandContext, value: DomainData): void {
  const hostname = textValue(value.domain.hostname);
  ctx.stdout.write(`${hostname}: ${textValue(value.domain.status, "unknown")}\n`);
  if (!value.dns) return;
  if (value.dns.cname_target) {
    ctx.stdout.write(`CNAME  ${hostname}  ${value.dns.cname_target}  (proxied)\n`);
  }
  for (const address of value.dns.apex_ipv4_targets) {
    ctx.stdout.write(`A      ${hostname}  ${address}\n`);
  }
  for (const record of value.dns.validation_records) {
    ctx.stdout.write(`TXT    ${record.name ?? ""}  ${record.value ?? ""}\n`);
  }
}

export function registerDomainCommands(define: DefineCommand): void {
  define({
    path: ["domains", "add"],
    flags: ["wait", "timeout"],
    positionals: { min: 1, max: 1, names: ["hostname"] },
    summary: "Add a custom domain",
    usage: "sites domains add <hostname> [--wait] [--timeout 900]",
    run: async (ctx): Promise<CommandResult<DomainData>> => {
      const hostname = validateHostname(ctx.positionals[0]);
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      let domain = await ctx.mcp().callTool<CustomDomainRecord>("sites.add_custom_domain", {
        project_id: projectId,
        hostname,
      });
      const timeout = integerOption(ctx.options, "timeout", { min: 1, max: 3600, fallback: 900 });
      if (ctx.options.wait && domain.id) {
        ctx.log(`waiting for ${hostname} to become active`);
        const deadline = Date.now() + timeout * 1000;
        while (Date.now() < deadline) {
          if (["active", "active_redeploying"].includes(String(domain.status))) break;
          await sleep(5000);
          domain = await ctx
            .mcp()
            .callTool<CustomDomainRecord>("sites.refresh_custom_domain_status", {
              project_id: projectId,
              custom_domain_id: domain.id,
            });
        }
        if (domain.status !== "active") {
          throw new CliError(
            "DOMAIN_TIMEOUT",
            `${hostname} is still ${domain.status ?? "pending"}.`,
            {
              exitCode: EXIT.NETWORK,
              hint: "Create the DNS records, then retry `sites domains refresh <hostname> --wait`.",
            },
          );
        }
      }
      const data = domainData(projectId, domain);
      return {
        data,
        human: (value) => {
          renderDomainInstructions(ctx, value);
          ctx.stdout.write(
            "DNS レコードを作成したら `sites domains refresh <hostname>` で確認できます。\n",
          );
        },
      };
    },
  });

  define({
    path: ["domains", "list"],
    flags: [],
    positionals: { min: 0, max: 0 },
    summary: "List custom domains",
    usage: "sites domains list",
    run: async (ctx): Promise<CommandResult<DomainListData>> => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const listed = await ctx
        .mcp()
        .callTool<ListCustomDomainsResult>("sites.list_custom_domains", {
          project_id: projectId,
        });
      const items = listed.items ?? [];
      return {
        data: { project_id: projectId, items },
        human: (value) => {
          if (!value.items.length) {
            ctx.stdout.write("カスタムドメインはありません。\n");
            return;
          }
          for (const item of value.items) {
            ctx.stdout.write(
              `${item.hostname ?? ""}  ${item.status ?? ""}  ${item.ssl_status ?? ""}  ${item.id ?? ""}\n`,
            );
          }
        },
      };
    },
  });

  define({
    path: ["domains", "refresh"],
    flags: [],
    positionals: { min: 1, max: 1, names: ["hostname|custom_domain_id"] },
    summary: "Refresh custom domain verification",
    usage: "sites domains refresh <hostname|custom_domain_id>",
    run: async (ctx): Promise<CommandResult<DomainData>> => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const domain = await resolveDomain(ctx, projectId, ctx.positionals[0]);
      const refreshed = await ctx
        .mcp()
        .callTool<CustomDomainRecord>("sites.refresh_custom_domain_status", {
          project_id: projectId,
          custom_domain_id: domain.id,
        });
      return {
        data: domainData(projectId, refreshed),
        human: (value) => renderDomainInstructions(ctx, value),
      };
    },
  });

  define({
    path: ["domains", "remove"],
    flags: [],
    positionals: { min: 1, max: 1, names: ["hostname|custom_domain_id"] },
    summary: "Remove a custom domain",
    usage: "sites domains remove <hostname|custom_domain_id>",
    run: async (
      ctx,
    ): Promise<
      CommandResult<{ project_id: string; removed: string; domain: Record<string, unknown> }>
    > => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const domain = await resolveDomain(ctx, projectId, ctx.positionals[0]);
      const removed = await ctx.mcp().callTool<CustomDomainRecord>("sites.remove_custom_domain", {
        project_id: projectId,
        custom_domain_id: domain.id,
      });
      return {
        data: {
          project_id: projectId,
          removed: domain.hostname ?? domain.id ?? String(ctx.positionals[0]),
          domain: removed as Record<string, unknown>,
        },
        human: (value) => {
          ctx.stdout.write(`${value.removed} を削除しました。\n`);
        },
      };
    },
  });
}

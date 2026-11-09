// `sites analytics` (plan §4).

import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type { AnalyticsOverview } from "../api-types.ts";
import { resolveProjectRef } from "../manifest.ts";
import { usageError } from "../errors.ts";
import { stringOption, stringifyJson, textValue } from "../util.ts";

const HOUR_MS = 60 * 60 * 1000;
const OFFSET_MS = -8 * HOUR_MS;

function parseWindow(value: string | undefined): number {
  if (!value) return 24 * HOUR_MS;
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) {
    throw usageError("USAGE_INVALID_VALUE", `Invalid --since value: ${value}`, {
      hint: "Use a duration such as 24h or 7d.",
    });
  }
  const amount = Number(match[1]);
  const duration =
    amount * (match[2] === "m" ? 60 * 1000 : match[2] === "h" ? HOUR_MS : 24 * HOUR_MS);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > Date.now()) {
    throw usageError("USAGE_INVALID_VALUE", `Invalid --since value: ${value}`, {
      hint: "Use a positive duration such as 24h or 7d within the Unix time range.",
    });
  }
  return duration;
}

function align(ms: number, direction: "floor" | "ceil"): number {
  const shifted = ms - OFFSET_MS;
  const aligned =
    direction === "floor"
      ? Math.floor(shifted / HOUR_MS) * HOUR_MS
      : Math.ceil(shifted / HOUR_MS) * HOUR_MS;
  return aligned + OFFSET_MS;
}

function windowOf(ctx: CommandContext): { start_time_ms: number; end_time_ms: number } {
  const now = Date.now();
  const start = align(now - parseWindow(stringOption(ctx.options, "since")), "floor");
  let end = align(now, "ceil");
  if (end <= start) end = start + HOUR_MS;
  return { start_time_ms: start, end_time_ms: end };
}

interface SummaryData {
  project_id: string;
  start_time_ms: number;
  end_time_ms: number;
  view: string | null;
  overview: AnalyticsOverview;
}

interface EventsData {
  project_id: string;
  start_time_ms: number;
  end_time_ms: number;
  events: Array<Record<string, unknown>>;
}

export function registerAnalyticsCommands(define: DefineCommand): void {
  define({
    path: ["analytics", "summary"],
    flags: ["since", "view"],
    positionals: { min: 0, max: 0 },
    summary: "Show site analytics",
    usage: "sites analytics summary [--since 24h] [--view classic|list]",
    run: async (ctx): Promise<CommandResult<SummaryData>> => {
      const view = stringOption(ctx.options, "view");
      if (view !== undefined && !["classic", "list"].includes(view)) {
        throw usageError("USAGE_INVALID_VALUE", `Invalid --view value: ${view}`, {
          hint: "Use classic or list.",
        });
      }
      const window = windowOf(ctx);
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const args: Record<string, unknown> = {
        project_id: projectId,
        ...window,
        granularity: "1h",
      };
      if (view) args.view = view;
      const overview = await ctx
        .mcp()
        .callTool<AnalyticsOverview>("sites.get_site_analytics_overview", args);
      return {
        data: { project_id: projectId, ...window, view: view ?? null, overview },
        human: (value) => {
          ctx.stdout.write(stringifyJson(value.overview) + "\n");
        },
      };
    },
  });

  define({
    path: ["analytics", "events"],
    flags: ["since"],
    positionals: { min: 0, max: 0 },
    summary: "List analytics events",
    usage: "sites analytics events [--since 24h]",
    run: async (ctx): Promise<CommandResult<EventsData>> => {
      const window = windowOf(ctx);
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const result = await ctx
        .mcp()
        .callTool<{ events?: Array<Record<string, unknown>> }>("sites.list_site_analytics_events", {
          project_id: projectId,
          ...window,
        });
      const events = result.events ?? [];
      return {
        data: { project_id: projectId, ...window, events },
        human: (value) => {
          if (!value.events.length) {
            ctx.stdout.write("No events.\n");
            return;
          }
          for (const event of value.events) {
            ctx.stdout.write(
              `${textValue(event.timestamp ?? event.event_time)}  ${JSON.stringify(event)}\n`,
            );
          }
        },
      };
    },
  });
}

export { align, parseWindow };

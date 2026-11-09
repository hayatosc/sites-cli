// `sites cli search`, `sites docs search`, and `sites schema` (plan §4).
//
// Dependency-free weighted substring search with exact command priority and
// bounded typo correction; return five compact {command, summary} entries.

import { editDistance } from "../args.ts";
import { bundledDocs } from "virtual:sites-docs";
import { CliError, usageError } from "../errors.ts";
import type { CommandDefinition, CommandResult, DefineCommand } from "../types.ts";

interface CliSearchHit {
  command: string;
  summary: string;
}

interface CliSearchDocument {
  command: string;
  summary: string;
  description: string;
  keywords: string;
  context: string;
}

interface DocSection {
  title: string;
  description: string;
  url: string;
  file: string;
  line: number;
}

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const COMMAND_TOOLS: Record<string, string[]> = {
  list: ["list_sites"],
  info: ["get_site"],
  create: ["check_slug_availability", "create_site"],
  deploy: [
    "save_site_version",
    "deploy_site_version",
    "deploy_private_site_version",
    "get_deployment_status",
  ],
  status: ["get_deployment_status"],
  logs: ["get_site_worker_logs"],
  open: ["get_site"],
  delete: ["delete_site"],
  "versions create": ["save_site_version"],
  "versions list": ["list_site_versions"],
  "versions show": ["get_site_version"],
  "versions get": ["get_site_version"],
  "versions rollback": ["deploy_site_version", "deploy_private_site_version"],
  "env list": ["get_environment"],
  "env get": ["get_environment"],
  "env pull": ["get_environment"],
  "env set": ["update_environment_variables"],
  "env unset": ["update_environment_variables"],
  "env push": ["update_environment_variables"],
  "access show": ["get_site"],
  "access set": ["update_site_access"],
  "domains add": ["add_custom_domain"],
  "domains list": ["list_custom_domains"],
  "domains get": ["list_custom_domains"],
  "domains refresh": ["refresh_custom_domain_status"],
  "domains remove": ["remove_custom_domain"],
  "analytics summary": ["get_site_analytics_overview"],
  "analytics events": ["list_site_analytics_events"],
};

const DOCS_BASE_URL = "https://github.com/hayatosc/sites-cli/blob/main/docs/";

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length >= 2);
}

function scoreText(text: string, query: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of query) {
    const count = haystack.split(term).length - 1;
    if (count > 0) score += count * (term.length >= 4 ? 2 : 1);
  }
  return score;
}

function readSections(): DocSection[] {
  const sections: DocSection[] = [];
  for (const doc of bundledDocs) {
    const lines = doc.content.split("\n");
    let heading = doc.file;
    let start = 1;
    let body: string[] = [];
    const flush = (): void => {
      const text = body.join("\n").trim();
      if (text) {
        sections.push({
          title: heading,
          description: text.length > 320 ? `${text.slice(0, 317)}...` : text,
          url: `${DOCS_BASE_URL}${doc.file}#L${start}`,
          file: doc.file,
          line: start,
        });
      }
    };
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(#{1,4})\s+(.+)$/.exec(lines[index]);
      if (match) {
        flush();
        heading = match[2].trim();
        start = index + 1;
        body = [];
      } else {
        body.push(lines[index]);
      }
    }
    flush();
  }
  return sections;
}

function searchDocument(item: CommandDefinition): CliSearchDocument {
  const command = `sites ${item.path.join(" ")}`;
  const summary = item.gunshi?.description ?? item.summary ?? "";
  const args = Object.entries(item.gunshi?.args ?? {});
  const parents = item.path
    .slice(0, -1)
    .map((_, index) => `sites ${item.path.slice(0, index + 1).join(" ")}`);
  return {
    command,
    summary,
    description: summary,
    keywords: (item.keywords ?? []).join(" "),
    context: [
      ...parents,
      item.usage ?? "",
      ...args.filter(([, schema]) => schema.type !== "positional").map(([name]) => name),
      ...args.filter(([, schema]) => schema.type === "positional").map(([name]) => name),
      summary,
    ].join(" "),
  };
}

export function searchCommands(commands: CommandDefinition[], query: string): CliSearchHit[] {
  const words = terms(query);
  const normalized = query.trim().toLowerCase();
  const fields = [
    ["command", 8],
    ["summary", 5],
    ["description", 2],
    ["keywords", 5],
    ["context", 0.5],
  ] as const;
  return commands
    .filter((command) => !command.hidden)
    .map(searchDocument)
    .map((document) => {
      const exact = document.command === normalized || document.command === `sites ${normalized}`;
      let score = 0;
      for (const [field, weight] of fields) {
        const text = document[field].toLowerCase();
        for (const word of words) {
          let count = text.split(word).length - 1;
          if (!count && word.length >= 5) {
            const limit = Math.floor(word.length * 0.2);
            if (
              terms(text).some(
                (token) =>
                  Math.abs(token.length - word.length) <= limit &&
                  editDistance(word, token) <= limit,
              )
            )
              count = 0.5;
          }
          score += count * weight;
        }
      }
      return { document, exact, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.score - left.score ||
        left.document.command.localeCompare(right.document.command),
    )
    .slice(0, 5)
    .map(({ document: { command, summary } }) => ({ command, summary }));
}

function suggestTool(wanted: string, tools: ToolSchema[]): string | null {
  const normalized = wanted.toLowerCase();
  let best: { name: string; score: number } | null = null;
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    if (name.includes(normalized) || normalized.includes(name)) {
      const score = Math.abs(name.length - normalized.length);
      if (!best || score < best.score) best = { name: tool.name, score };
    }
  }
  return best?.name ?? null;
}

export function registerDocsCommands(define: DefineCommand, commands: CommandDefinition[]): void {
  define({
    path: ["cli", "search"],
    positionals: { min: 1, max: 1, names: ["query"] },
    summary: "Search all CLI commands by intent",
    usage: 'sites cli search "<describe the task>"',
    run: async (ctx): Promise<CommandResult<CliSearchHit[]>> => {
      const query = ctx.positionals[0]?.trim() ?? "";
      if (!query) throw usageError("USAGE_EMPTY_QUERY", "The search query is empty.");
      const results = searchCommands(commands, query);
      return {
        data: results,
        human: (value) => {
          for (const hit of value) {
            ctx.stdout.write(`${hit.command}\t${hit.summary}\n`);
          }
        },
      };
    },
  });

  define({
    path: ["docs", "search"],
    positionals: { min: 1, max: 1, names: ["query"] },
    summary: "Search the bundled documentation",
    usage: 'sites docs search "<question>"',
    run: async (ctx): Promise<CommandResult<DocSection[]>> => {
      const query = ctx.positionals[0]?.trim() ?? "";
      if (!query) throw usageError("USAGE_EMPTY_QUERY", "The search query is empty.");
      const words = terms(query);
      const results = readSections()
        .map((section) => ({
          section,
          score: scoreText(`${section.title}\n${section.description}`, words),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 5)
        .map((entry) => entry.section);
      return {
        data: results,
        human: (value) => {
          for (const hit of value) {
            ctx.stdout.write(`${hit.url}\n${hit.title}\n${hit.description}\n\n`);
          }
        },
      };
    },
  });

  define({
    path: ["schema"],
    flags: ["list"],
    positionals: { min: 0, max: Number.POSITIVE_INFINITY, names: ["tool|command.."] },
    summary: "Show MCP tool input schemas",
    usage: "sites schema <tool|command..>  or  sites schema --list",
    run: async (ctx): Promise<CommandResult<ToolSchema | ToolSchema[]>> => {
      const wanted = ctx.positionals.join(" ").trim();
      if (!wanted && !ctx.options.list) {
        throw new CliError(
          "USAGE_MISSING_ARGUMENT",
          "Schema requires a tool name or command path.",
          {
            exitCode: 1,
            hint: "Usage: sites schema <tool|command..>  or  sites schema --list",
          },
        );
      }
      const tools = await ctx.mcp().listTools();
      if (ctx.options.list) {
        const summary = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        }));
        return {
          data: summary,
          human: (value) => {
            for (const tool of value as ToolSchema[]) ctx.stdout.write(`${tool.name}\n`);
          },
        };
      }
      const registered = commands.find(
        (command) => command.gunshi && command.path.join(" ") === wanted,
      );
      const mappedNames = registered ? COMMAND_TOOLS[registered.path.join(" ")] : undefined;
      if (mappedNames) {
        const schemas = mappedNames.map((name) =>
          tools.find((tool) => tool.name === `sites.${name}`),
        );
        if (schemas.some((schema) => !schema)) {
          throw new CliError(
            "NOT_FOUND_TOOL",
            `The server does not advertise every tool used by "${wanted}".`,
          );
        }
        const available = schemas.filter((schema): schema is ToolSchema => schema !== undefined);
        return { data: available.length === 1 ? available[0] : available };
      }
      const tool = tools.find((entry) => entry.name === wanted || entry.name === `sites.${wanted}`);
      if (!tool) {
        const suggestion = suggestTool(wanted, tools);
        throw new CliError("NOT_FOUND_TOOL", `Schema not found for "${wanted}".`, {
          exitCode: 1,
          hint: suggestion
            ? `Did you mean \`sites schema ${suggestion}\`?`
            : "Run `sites schema --list` to see available tools.",
        });
      }
      return {
        data: tool,
        human: (value) => {
          ctx.stdout.write(`${(value as ToolSchema).name}\n`);
          ctx.stdout.write(`${JSON.stringify((value as ToolSchema).inputSchema, null, 2)}\n`);
        },
      };
    },
  });
}

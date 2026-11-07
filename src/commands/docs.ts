// `sites cli search`, `sites docs search`, and `sites schema` (plan §4).
//
// Search follows the cf CLI: commands are ranked with MiniSearch over the
// command path, summary, description, keywords, and context; the result is
// limited to five compact {command, summary} entries.

import MiniSearch from "minisearch";
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
  const parents = item.path
    .slice(0, -1)
    .map((_, index) => `sites ${item.path.slice(0, index + 1).join(" ")}`);
  return {
    command,
    summary: item.summary ?? "",
    description: item.summary ?? "",
    keywords: (item.keywords ?? []).join(" "),
    context: [
      ...parents,
      item.usage ?? "",
      ...(item.flags ?? []),
      ...(item.positionals?.names ?? []),
      item.summary ?? "",
    ].join(" "),
  };
}

export function searchCommands(commands: CommandDefinition[], query: string): CliSearchHit[] {
  const index = new MiniSearch<CliSearchDocument>({
    fields: ["command", "summary", "description", "keywords", "context"],
    storeFields: ["command", "summary"],
    idField: "command",
  });
  index.addAll(commands.map(searchDocument));
  return index
    .search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: {
        command: 8,
        summary: 5,
        description: 2,
        keywords: 5,
        context: 0.5,
      },
    })
    .slice(0, 5)
    .map(({ command, summary }) => ({
      command: String(command),
      summary: String(summary),
    }));
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
    positionals: { min: 0, max: 1, names: ["tool"] },
    summary: "Show MCP tool input schemas",
    usage: "sites schema <tool>  or  sites schema --list",
    run: async (ctx): Promise<CommandResult<ToolSchema | ToolSchema[]>> => {
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
      const wanted = ctx.positionals[0];
      if (!wanted) {
        throw new CliError("USAGE_MISSING_ARGUMENT", "Schema requires a tool name.", {
          exitCode: 1,
          hint: "Usage: sites schema <tool>  or  sites schema --list",
        });
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

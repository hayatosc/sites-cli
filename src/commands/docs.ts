// `sites cli search`, `sites docs search`, and `sites schema` (plan §4).

import { bundledDocs } from "virtual:sites-docs";
import type { CommandDefinition, CommandResult, DefineCommand } from "../types.ts";
import { CliError, usageError } from "../errors.ts";

interface CliSearchHit {
  command: string;
  summary: string;
  score: number;
}

interface DocSection {
  file: string;
  heading: string;
  line: number;
  excerpt: string;
  score: number;
}

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

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
          file: doc.file,
          heading,
          line: start,
          excerpt: text.length > 320 ? `${text.slice(0, 317)}...` : text,
          score: 0,
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

export function registerDocsCommands(define: DefineCommand, commands: CommandDefinition[]): void {
  define({
    path: ["cli", "search"],
    positionals: { min: 1, max: 1, names: ["query"] },
    summary: "Find commands that match a task",
    usage: "sites cli search <query>",
    run: async (_ctx): Promise<CommandResult<{ query: string; results: CliSearchHit[] }>> => {
      const query = _ctx.positionals[0]?.trim() ?? "";
      if (!query) throw usageError("USAGE_EMPTY_QUERY", "The search query is empty.");
      const words = terms(query);
      const results: CliSearchHit[] = [];
      for (const command of commands) {
        const name = command.path.join(" ");
        const score =
          scoreText(name, words) * 3 +
          scoreText(command.summary ?? "", words) * 2 +
          scoreText(command.usage ?? "", words) +
          scoreText((command.flags ?? []).join(" "), words);
        if (score > 0) results.push({ command: name, summary: command.summary ?? "", score });
      }
      results.sort(
        (left, right) => right.score - left.score || left.command.localeCompare(right.command),
      );
      return {
        data: { query, results: results.slice(0, 5) },
        human: (value) => {
          for (const hit of value.results) {
            _ctx.stdout.write(`${hit.command}\t${hit.summary}\n`);
          }
        },
      };
    },
  });

  define({
    path: ["docs", "search"],
    positionals: { min: 1, max: 1, names: ["query"] },
    summary: "Search the bundled documentation",
    usage: "sites docs search <query>",
    run: async (ctx): Promise<CommandResult<{ query: string; results: DocSection[] }>> => {
      const query = ctx.positionals[0]?.trim() ?? "";
      if (!query) throw usageError("USAGE_EMPTY_QUERY", "The search query is empty.");
      const words = terms(query);
      const results = readSections()
        .map((section) => ({
          ...section,
          score: scoreText(`${section.heading}\n${section.excerpt}`, words),
        }))
        .filter((section) => section.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      return {
        data: { query, results },
        human: (value) => {
          for (const hit of value.results) {
            ctx.stdout.write(`${hit.file}:${hit.line}  ${hit.heading}\n${hit.excerpt}\n\n`);
          }
        },
      };
    },
  });

  define({
    path: ["schema"],
    flags: [],
    positionals: { min: 0, max: 1, names: ["tool"] },
    summary: "Print MCP tool input schemas",
    usage: "sites schema [tool]",
    run: async (ctx): Promise<CommandResult<{ tools: ToolSchema[] }>> => {
      const tools = await ctx.mcp().listTools();
      const wanted = ctx.positionals[0];
      if (!wanted) {
        return {
          data: { tools },
          human: (value) => {
            for (const tool of value.tools) ctx.stdout.write(`${tool.name}\n`);
          },
        };
      }
      const tool = tools.find((entry) => entry.name === wanted || entry.name === `sites.${wanted}`);
      if (!tool) {
        throw new CliError("NOT_FOUND_TOOL", `Unknown MCP tool: ${wanted}`, {
          exitCode: 5,
          hint: "Run `sites schema` to list the available tools.",
        });
      }
      return {
        data: { tools: [tool] },
        human: (value) => {
          ctx.stdout.write(
            `${value.tools[0].name}\n${JSON.stringify(value.tools[0].inputSchema, null, 2)}\n`,
          );
        },
      };
    },
  });
}

// Local SQL scaffolding; deployment, not a speculative SQL API, applies migrations.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CliError, EXIT, usageError } from "../errors.ts";
import { stringOption } from "../util.ts";
import type { DefineCommand } from "../types.ts";

function normalize(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, "") || ".";
}

// Only a basename's * and ? are interpreted. Greedy retry at the last star
// avoids the exponential regex backtracking of repeated wildcard fragments.
function matchesFileName(name: string, pattern: string): boolean {
  const chars = Array.from(name);
  const tokens = Array.from(pattern);
  let file = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  while (file < chars.length) {
    if (tokens[token] === "?" || tokens[token] === chars[file]) {
      token++;
      file++;
    } else if (tokens[token] === "*") {
      star = token++;
      retry = file;
    } else if (star !== -1) {
      token = star + 1;
      file = ++retry;
    } else return false;
  }
  while (tokens[token] === "*") token++;
  return token === tokens.length;
}

export function registerMigrationCommands(define: DefineCommand): void {
  define({
    path: ["migrations", "create"],
    flags: ["dir", "pattern"],
    positionals: { min: 1, max: 1, names: ["message"] },
    summary: "Create an empty numbered SQL migration locally",
    usage: "sites migrations create <message> [--dir drizzle] [--pattern '<dir>/*.sql']",
    run: async (ctx) => {
      const rawDir = stringOption(ctx.options, "dir");
      const rawPattern = stringOption(ctx.options, "pattern");
      if (rawPattern !== undefined && rawDir === undefined)
        throw usageError("USAGE_MIGRATION_PATTERN", "--pattern requires --dir.");
      const dir = normalize(rawDir ?? "drizzle");
      const patternHint =
        "Use <dir>/<filename>.sql with literal characters, * and ? only; no subdirectories, **, braces, character classes, negation or extglobs.";
      if (
        rawPattern &&
        /\*\*|[{}[\]()!]|(?:^|\/)\.\.(?:\/|$)/.test(rawPattern.replaceAll("\\", "/"))
      )
        throw usageError("USAGE_MIGRATION_PATTERN", "Unsupported migration pattern.", {
          hint: patternHint,
        });
      const pattern = normalize(rawPattern ?? `${dir}/*.sql`);
      if (dir !== "." && !pattern.startsWith(`${dir}/`))
        throw usageError("USAGE_MIGRATION_PATTERN", "--pattern must be under --dir.");
      if (dir === "." && (path.posix.isAbsolute(pattern) || pattern.startsWith("../")))
        throw usageError("USAGE_MIGRATION_PATTERN", "--pattern must be under --dir.");
      const relativePattern = dir === "." ? pattern : pattern.slice(dir.length + 1);
      if (relativePattern.includes("/") || !relativePattern.endsWith(".sql"))
        throw usageError("USAGE_MIGRATION_PATTERN", "Unsupported migration pattern.", {
          hint: patternHint,
        });
      const matches = (file: string): boolean =>
        !file.startsWith(".") &&
        (rawPattern === undefined ? file.endsWith(".sql") : matchesFileName(file, relativePattern));
      const name = ctx.positionals[0].replaceAll(" ", "_");
      if (!name.trim() || /[\\/:*?"<>|]|\p{Cc}/u.test(name))
        throw usageError(
          "USAGE_MIGRATION_NAME",
          "Migration names must be nonempty portable file names without path separators.",
        );
      const directory = path.resolve(ctx.root, dir);
      let next = 1;
      // Default SQL selection uses only standard directory enumeration. Never
      // recurse or follow symlinks, and do not call experimental matchesGlob.
      if (fs.existsSync(directory)) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isFile() && matches(entry.name)) {
            const number = Number.parseInt(entry.name.split("_")[0], 10);
            if (Number.isFinite(number)) next = Math.max(next, number + 1);
          }
        }
      }
      if (!Number.isSafeInteger(next))
        throw usageError(
          "USAGE_MIGRATION_NUMBER",
          "The next migration number exceeds the safe integer range.",
        );
      const number = String(next).padStart(4, "0");
      const fileName = `${number}_${name}.sql`;
      if (!matches(fileName))
        throw usageError(
          "USAGE_MIGRATION_PATTERN",
          "The proposed top-level SQL file would not match --pattern.",
          {
            hint: "For an ORM-managed nested layout, use its generator (for example drizzle-kit generate).",
          },
        );
      if (!fs.existsSync(directory) && process.stdin.isTTY && !ctx.yes) {
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          rl.question(`? No migrations folder found. Create ${directory}? [Y/n] `, (value) => {
            rl.close();
            resolve(value.trim().toLowerCase());
          });
        });
        if (answer && answer !== "y" && answer !== "yes")
          throw new CliError("CANCELLED", "Migration creation cancelled.", {
            exitCode: EXIT.INTERRUPT,
          });
      }
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, fileName);
      try {
        fs.writeFileSync(file, `-- Migration number: ${number} \t ${new Date().toISOString()}\n`, {
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new CliError(
            "CONFLICT_FILE_EXISTS",
            "The migration already exists; retry to select a new number.",
            { exitCode: EXIT.CONFLICT },
          );
        throw error;
      }
      ctx.success(`Created ${fileName}`);
      return { data: { name: fileName, path: file } };
    },
  });
}

// `sites init` (plan §4.1).

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.ts";
import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import { git, gitAvailable } from "../git.ts";
import { MANIFEST_DIR, MANIFEST_NAME, manifestPath, readManifest } from "../manifest.ts";
import { detectProject } from "../project-detect.ts";

const TEMPLATES = ["static", "worker-esm"] as const;
type Template = (typeof TEMPLATES)[number];

const STATIC_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My Sites Site</title>
</head>
<body>
  <h1>Hello from Sites</h1>
</body>
</html>
`;

const WORKER_INDEX = `export default {
  async fetch(request) {
    return new Response("Hello from Sites", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;

const BUILD_SCRIPT = `import fs from "node:fs";
import path from "node:path";

const template = process.argv[2];

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

fs.rmSync("dist", { recursive: true, force: true });
if (template === "worker-esm") {
  copyDirectory("worker", path.join("dist", "server"));
} else {
  copyDirectory("public", "dist");
}
`;

interface InitData {
  directory: string;
  template: Template | "existing";
  git_initialized: boolean;
  files: string[];
}

function writeIfAllowed(file: string, content: string, force: boolean, created: string[]): void {
  if (fs.existsSync(file) && !force) {
    throw new CliError("CONFLICT_FILE_EXISTS", `Refusing to overwrite ${file}.`, {
      exitCode: EXIT.PREFLIGHT,
      hint: "Pass --force to overwrite generated files.",
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  created.push(file);
}

export function registerInitCommands(define: DefineCommand): void {
  define({
    path: ["init"],
    flags: ["template", "force", "no-git"],
    positionals: { min: 0, max: 1, names: ["dir"] },
    summary: "Initialize a site project",
    usage: "sites init [dir] [--template static|worker-esm] [--force] [--no-git]",
    async run(ctx: CommandContext): Promise<CommandResult<InitData>> {
      const target = ctx.positionals[0] ? path.resolve(ctx.cwd, ctx.positionals[0]) : ctx.cwd;
      const template = (
        typeof ctx.options.template === "string" ? ctx.options.template : "static"
      ) as Template;
      if (!TEMPLATES.includes(template)) {
        throw new CliError("USAGE_INVALID_VALUE", `Unknown template: ${template}`, {
          exitCode: EXIT.USAGE,
          hint: `Use one of: ${TEMPLATES.join(", ")}.`,
        });
      }
      const force = Boolean(ctx.options.force);
      if (fs.existsSync(manifestPath(target)) && readManifest(target).manifest.project_id) {
        throw new CliError(
          "CONFLICT_LINKED_PROJECT",
          "This directory is already linked to a site.",
          {
            exitCode: EXIT.PREFLIGHT,
            hint: "Keep the existing manifest or choose a different directory.",
          },
        );
      }
      const existing =
        !ctx.options.template &&
        (fs.existsSync(path.join(target, "package.json")) ||
          fs.existsSync(path.join(target, "index.html")) ||
          fs.existsSync(path.join(target, "public", "index.html")));
      if (fs.existsSync(target) && !force && !existing) {
        const entries = fs.readdirSync(target).filter((name) => name !== ".git");
        if (entries.length) {
          throw new CliError("CONFLICT_DIRECTORY_NOT_EMPTY", `Directory is not empty: ${target}`, {
            exitCode: EXIT.PREFLIGHT,
            hint: "Choose an empty directory or pass --force.",
          });
        }
      }
      fs.mkdirSync(target, { recursive: true });
      const files: string[] = [];
      const detection = existing ? detectProject(target) : null;
      const worker = existing ? detection?.kind === "worker" : template === "worker-esm";
      const manifest = worker
        ? { project_id: null }
        : { project_id: null, static: { directory: "dist", not_found_handling: "404-page" } };
      writeIfAllowed(
        path.join(target, MANIFEST_DIR, MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        force,
        files,
      );
      if (!existing) {
        if (template === "static") {
          writeIfAllowed(path.join(target, "public", "index.html"), STATIC_HTML, force, files);
        } else {
          writeIfAllowed(path.join(target, "worker", "index.js"), WORKER_INDEX, force, files);
        }
        writeIfAllowed(path.join(target, "scripts", "build.mjs"), BUILD_SCRIPT, force, files);
        writeIfAllowed(
          path.join(target, "package.json"),
          `${JSON.stringify({ private: true, type: "module", scripts: { build: `node scripts/build.mjs ${template}` } }, null, 2)}\n`,
          force,
          files,
        );
      }
      const ignoreFile = path.join(target, ".gitignore");
      const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
      const additions = ["dist/", ".sites/", "node_modules/"].filter(
        (entry) => !ignore.split(/\r?\n/).includes(entry),
      );
      if (additions.length) {
        fs.writeFileSync(
          ignoreFile,
          `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`,
        );
        files.push(ignoreFile);
      }

      let gitInitialized = false;
      if (!ctx.options["no-git"]) {
        if (await gitAvailable()) {
          const result = await git(["init", "--initial-branch", "main"], {
            cwd: target,
            env: ctx.env,
            allowFailure: true,
          });
          gitInitialized = result.code === 0;
          if (!gitInitialized)
            ctx.stderr.write(`warning: git init failed; continuing without a repository\n`);
        } else {
          ctx.stderr.write("warning: git is not installed; continuing without a repository\n");
        }
      }

      ctx.success(`Initialized ${existing ? "existing" : template} site in ${target}`);
      return {
        data: {
          directory: target,
          template: existing ? "existing" : template,
          git_initialized: gitInitialized,
          files,
        },
        human: (value) => {
          ctx.stdout.write(`Initialized ${value.template} site in ${value.directory}\n`);
          if (!value.git_initialized) ctx.stdout.write("Git repository: not initialized\n");
          ctx.stdout.write("Next: sites create <slug>\n");
        },
      };
    },
  });
}

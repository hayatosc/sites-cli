// Local project workflows adapted from cf's build/dev/migrate/complete commands.

import fs from "node:fs";
import os, { constants } from "node:os";
import path from "node:path";
import { spawnCommand } from "../subprocess.ts";
import { flagArgumentEnd, GLOBAL_FLAGS } from "../args.ts";
import { dirtyFiles } from "../git.ts";
import { buildSite } from "../build.ts";
import { convertWranglerProject } from "../convert.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { manifestPath, readManifest, writeManifest } from "../manifest.ts";
import { inspectDist } from "../package-site.ts";
import { detectProject, readPackageJson } from "../project-detect.ts";
import { registerSignalHandler, stringListOption } from "../util.ts";
import type { CommandDefinition, CommandResult, DefineCommand } from "../types.ts";

function completions(words: string[], commands: CommandDefinition[]): string[] {
  const prefix = words.at(-1) ?? "";
  const parents: string[] = [];
  for (let index = 0; index < words.length - 1; index++) {
    const token = words[index];
    if (token === "--") return [];
    if (token.startsWith("-") && token !== "-") {
      index = flagArgumentEnd(words, index);
      // The current word is a flag value, not a command or another option.
      if (index === words.length - 1) return [];
    } else parents.push(token);
  }
  const visible = commands.filter((command) => !command.hidden);
  const command = visible.find((candidate) =>
    candidate.path.every((part, index) => parents[index] === part),
  );
  const choices =
    prefix.startsWith("-") || command
      ? [...new Set([...GLOBAL_FLAGS, ...(command?.flags ?? [])])].map((flag) => `--${flag}`)
      : visible
          .filter((candidate) => parents.every((part, index) => candidate.path[index] === part))
          .map((candidate) => candidate.path[parents.length])
          .filter((part): part is string => Boolean(part));
  return [...new Set(choices)].filter((choice) => choice.startsWith(prefix)).sort();
}

const COMPLETION_SCRIPTS: Record<string, string> = {
  bash: `_sites_complete() {
  local IFS=$'\\n'
  COMPREPLY=($(sites complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}"))
}
complete -F _sites_complete sites
`,
  zsh: `#compdef sites
_sites_complete() {
  local -a candidates
  candidates=("\${(@f)$(sites complete -- "\${words[@]:1}")}")
  compadd -- "\${candidates[@]}"
}
compdef _sites_complete sites
`,
  fish: `complete -c sites -f -a '(sites complete -- (commandline -opc)[2..-1] (commandline -ct))'
`,
  powershell: `Register-ArgumentCompleter -Native -CommandName sites -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if (-not $wordToComplete) { $words += '' }
  sites complete -- @words | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`,
};

export function registerLocalCommands(define: DefineCommand, commands: CommandDefinition[]): void {
  define({
    path: ["build"],
    flags: ["prebuilt", "no-build-script", "allow-unsupported"],
    positionals: { min: 0, max: 0 },
    summary: "Build and validate local site output without deploying",
    usage: "sites build [--prebuilt] [--no-build-script]",
    run: async (ctx) => {
      if (!fs.existsSync(manifestPath(ctx.root))) {
        const converted = await convertWranglerProject({
          root: ctx.root,
          allowUnsupported: stringListOption(ctx.options, "allow-unsupported"),
          log: ctx.log,
        });
        if (!converted) readManifest(ctx.root);
      }
      const build = await buildSite({
        root: ctx.root,
        env: ctx.env,
        prebuilt: Boolean(ctx.options.prebuilt),
        noBuildScript: Boolean(ctx.options["no-build-script"]),
        log: ctx.log,
        output: ctx.stderr,
        quiet: ctx.quiet,
      });
      const dist = inspectDist(ctx.root, readManifest(ctx.root).manifest);
      ctx.success("Build complete");
      return {
        data: {
          kind: dist.kind,
          file_count: dist.fileCount,
          size_bytes: dist.sizeBytes,
          tree_hash: dist.treeHash,
          detection: build.detection,
        },
      };
    },
  });

  define({
    path: ["dev"],
    forwardArgs: true,
    positionals: { min: 0, max: Number.POSITIVE_INFINITY, names: ["args.."] },
    summary: "Run the project's local dev script (not a Sites runtime emulator)",
    usage: "sites dev [-- <dev-script arguments..>]",
    run: async (ctx) => {
      const pkg = readPackageJson(ctx.root);
      if (!pkg?.scripts?.dev)
        throw new CliError("PREFLIGHT_NO_DEV_SCRIPT", "No package.json dev script is configured.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Add a dev script for your framework. Sites service bindings are not emulated locally.",
        });
      const manager = detectProject(ctx.root).packageManager;
      if (!["npm", "pnpm", "yarn", "bun", "aube"].includes(manager))
        throw usageError(
          "PREFLIGHT_UNSUPPORTED_PACKAGE_MANAGER",
          `Unsupported package manager: ${manager}`,
        );
      const args = [
        "run",
        "dev",
        ...(["npm", "aube"].includes(manager) && ctx.positionals.length ? ["--"] : []),
        ...ctx.positionals,
      ];
      ctx.log(
        `$ ${manager} run dev${ctx.positionals.length ? ` (forwarding ${ctx.positionals.length} arguments)` : ""}`,
      );
      const child = spawnCommand(manager, args, {
        cwd: ctx.root,
        env: ctx.env,
        // Native CLI streams must keep their file descriptors/TTY semantics.
        // Injected embedding/test streams need relaying instead.
        stdio: [
          "inherit",
          ctx.quiet ? "ignore" : ctx.stdout === process.stdout ? "inherit" : "pipe",
          ctx.quiet ? "ignore" : ctx.stderr === process.stderr ? "inherit" : "pipe",
        ],
      });
      child.stdout?.on("data", (data: Buffer) => ctx.stdout.write(data.toString()));
      child.stderr?.on("data", (data: Buffer) => ctx.stderr.write(data.toString()));
      let forwardedSignal: NodeJS.Signals | undefined;
      const unregister = registerSignalHandler((signal) => {
        forwardedSignal ??= signal;
        // Windows already broadcasts console Ctrl+C; kill would bypass graceful shutdown.
        if (process.platform !== "win32" || signal !== "SIGINT") child.kill(signal);
      });
      let code: number;
      try {
        code = await new Promise<number>((resolve, reject) => {
          child.once("error", (error) =>
            reject(
              new CliError("DEV_START_FAILED", `Could not start ${manager}: ${error.message}`),
            ),
          );
          child.once("close", (code, signal) => {
            const termination = signal ?? forwardedSignal;
            resolve(code ?? (termination ? 128 + (constants.signals[termination] ?? 1) : 1));
          });
        });
      } finally {
        unregister();
      }
      return { data: { command: manager, exit_code: code }, raw: "", exitCode: code };
    },
  });

  define({
    path: ["migrate"],
    nativeDryRun: true,
    flags: ["force", "allow-unsupported"],
    positionals: { min: 0, max: 1, names: ["path"] },
    summary: "Convert Wrangler configuration into a Sites manifest and bundle",
    usage: "sites migrate [path] [--dry-run] [--force] [--allow-unsupported <binding>]",
    run: async (ctx) => {
      const input = ctx.positionals[0] ? path.resolve(ctx.cwd, ctx.positionals[0]) : ctx.root;
      const directory = fs.existsSync(input) && fs.statSync(input).isDirectory();
      const root = directory ? input : path.dirname(input);
      const dirty = await dirtyFiles(root);
      if (dirty.length && !ctx.options.force)
        throw new CliError("CONFLICT_DIRTY_TREE", "The working tree has uncommitted changes.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Commit the changes or pass --force after reviewing them.",
        });
      const existing = fs.existsSync(manifestPath(root)) ? readManifest(root).manifest : null;
      if (existing && !ctx.options.force)
        throw new CliError("CONFLICT_FILE_EXISTS", "A Sites manifest already exists.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Review it first; use --force to replace conversion settings while retaining project_id.",
        });
      const report = await convertWranglerProject({
        root,
        configPath: directory ? undefined : input,
        dryRun: Boolean(ctx.options["dry-run"]),
        allowUnsupported: stringListOption(ctx.options, "allow-unsupported"),
        log: ctx.log,
      });
      if (!report)
        throw new CliError("PREFLIGHT_NO_WRANGLER", "No Wrangler configuration was found.", {
          exitCode: EXIT.PREFLIGHT,
        });
      if (existing?.project_id && !ctx.options["dry-run"])
        writeManifest(root, { ...readManifest(root).manifest, project_id: existing.project_id });
      return { data: { ...report, dry_run: Boolean(ctx.options["dry-run"]) } };
    },
  });

  define({
    path: ["complete"],
    positionals: { min: 0, max: Number.POSITIVE_INFINITY, names: ["shell|words.."] },
    summary: "Generate shell completion scripts or completion candidates",
    usage: "sites complete [bash|zsh|fish|powershell]  or  sites complete -- <words..>",
    run: async (ctx): Promise<CommandResult<{ shell: string } | string[]>> => {
      const shell = ctx.positionals[0];
      const runtime = ctx.argv.includes("--");
      if (!runtime && ctx.positionals.length === 1) {
        if (!Object.hasOwn(COMPLETION_SCRIPTS, shell))
          throw usageError("USAGE_UNSUPPORTED_SHELL", `Unsupported shell: ${shell}`, {
            hint: "Use bash, zsh, fish, or powershell.",
          });
        return { data: { shell }, raw: COMPLETION_SCRIPTS[shell] };
      }
      if (!runtime && !ctx.positionals.length) {
        const detected = path.basename(
          ctx.env.SHELL ?? (os.platform() === "win32" ? "powershell" : "bash"),
        );
        if (!Object.hasOwn(COMPLETION_SCRIPTS, detected))
          throw usageError("USAGE_UNSUPPORTED_SHELL", `Unsupported shell: ${detected}`, {
            hint: "Use bash, zsh, fish, or powershell.",
          });
        return { data: { shell: detected }, raw: COMPLETION_SCRIPTS[detected] };
      }
      const candidates = completions(ctx.positionals, commands);
      return { data: candidates, raw: candidates.length ? candidates.join("\n") + "\n" : "" };
    },
  });
}

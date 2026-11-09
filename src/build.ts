// Build orchestration for `sites deploy` (plan §5.1 step 3), using cf-style
// project detection for the build command and output directory.

import { spawnCommand } from "./subprocess.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, CommandExit, EXIT } from "./errors.ts";
import { readManifest } from "./manifest.ts";
import { bundleWorker, resolveWorkerEntry } from "./bundler.ts";
import {
  detectProject,
  findBuildOutput,
  findStaticDirectory,
  packageCommand,
  type ProjectDetection,
} from "./project-detect.ts";
import type { Env, OutputStream } from "./types.ts";
import { registerSignalHandler } from "./util.ts";

export interface BuildResult {
  mode: "script" | "framework" | "static-copy" | "worker-bundle" | "prebuilt";
  command: string | null;
  detection: ProjectDetection;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function runBuildProcess(options: {
  file: string;
  args: string[];
  cwd: string;
  env: Env;
  label: string;
  output: OutputStream;
  quiet?: boolean;
  /** Internal timing overrides for subprocess regression tests. */
  timeoutMs?: number;
  killGraceMs?: number;
}): Promise<void> {
  const { file, args, cwd, env, label, output, quiet } = options;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const killGraceMs = options.killGraceMs ?? 5000;
  // Like cf, both build streams go to stderr, never the JSON result channel.
  // Real stderr inheritance preserves TTY detection; injected streams are relayed.
  const inherit = !quiet && output === process.stderr;
  const child = spawnCommand(file, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["inherit", inherit ? process.stderr : "pipe", inherit ? "inherit" : "pipe"],
  });
  let tail = "";
  const relay = (chunk: string): void => {
    tail = (tail + chunk).slice(-64 * 1024);
    if (!quiet) output.write(chunk);
  };
  child.stdout?.setEncoding("utf8").on("data", relay);
  child.stderr?.setEncoding("utf8").on("data", relay);
  let timedOut = false;
  let forwardedSignal: NodeJS.Signals | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const terminate = (signal: NodeJS.Signals): void => {
    child.kill(signal);
    if (signal === "SIGTERM" && !fallback)
      fallback = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  };
  const unregister = registerSignalHandler((signal) => {
    forwardedSignal ??= signal;
    if (process.platform !== "win32" || signal !== "SIGINT") terminate(signal);
  });
  // Retain the existing bounded-build safeguard, but make timeout explicit and
  // escalate if a build ignores SIGTERM instead of waiting forever.
  const timer = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
  }, timeoutMs);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(fallback);
    unregister();
  }
  const details = { command: label, output: tail.trim().split("\n").slice(-30).join("\n") };
  if (timedOut)
    throw new CliError("BUILD_TIMEOUT", `${label} exceeded the ${timeoutMs}ms build deadline.`, {
      hint: "Optimize the build, or build separately and deploy with --prebuilt.",
      details: { ...details, timeout_ms: timeoutMs },
    });
  const signal = result.signal ?? forwardedSignal;
  const code = result.code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
  // Even a graceful exit 0 after interruption must not continue into upload.
  if (signal) throw new CommandExit(code);
  if (code !== 0)
    throw new CliError("BUILD_FAILED", `${label} exited with code ${code}.`, {
      exitCode: code,
      hint: "Fix the build error and retry.",
      details,
    });
}

function copyStaticAssets(root: string, source: string, dist: string): void {
  if (source === dist) return;
  let staging: string | null = null;
  if (isInside(dist, source)) {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), "sites-static-"));
    fs.cpSync(source, staging, { recursive: true });
    source = staging;
  }
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  if (source === root) {
    const skipped = new Set(["dist", ".git", "node_modules", ".sites", ".openai", "outputs"]);
    for (const entry of fs.readdirSync(root)) {
      if (skipped.has(entry)) continue;
      fs.cpSync(path.join(root, entry), path.join(dist, entry), { recursive: true });
    }
  } else {
    fs.cpSync(source, dist, { recursive: true });
  }
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
}

export async function buildSite(options: {
  root: string;
  env?: Env;
  noBuildScript: boolean;
  prebuilt?: boolean;
  log: (text: string) => void;
  output?: OutputStream;
  quiet?: boolean;
}): Promise<BuildResult> {
  const { root, log } = options;
  const outputStream = options.output ?? { write: (text: string) => log(text.replace(/\n$/, "")) };
  const env = options.env ?? {};
  const detection = detectProject(root);
  for (const warning of detection.warnings) log(`warning: ${warning}`);

  if (options.prebuilt) {
    return { mode: "prebuilt", command: null, detection };
  }

  let mode: BuildResult["mode"] = "prebuilt";
  let command: string | null = null;

  if (!options.noBuildScript) {
    if (detection.buildScript) {
      command = `${detection.packageManager} run ${detection.buildScript}`;
      log(`detected ${detection.framework?.name ?? "package"} project (${command})`);
      log(`running ${command}`);
      await runBuildProcess({
        output: outputStream,
        quiet: options.quiet,
        file: detection.packageManager,
        args: ["run", detection.buildScript],
        cwd: root,
        env,
        label: command,
      });
      mode = "script";
    } else if (detection.buildCommand) {
      const argv = packageCommand(detection.packageManager, detection.buildCommand);
      command = argv.join(" ");
      log(`detected ${detection.framework?.name ?? "project"} (${command})`);
      log(`running ${command}`);
      await runBuildProcess({
        file: argv[0],
        args: argv.slice(1),
        cwd: root,
        env,
        label: command,
        output: outputStream,
        quiet: options.quiet,
      });
      mode = "framework";
    }
  }

  const manifest = readManifest(root).manifest;
  const built = mode !== "prebuilt";
  const output = findBuildOutput(root, detection);

  if (manifest.static) {
    const dist = path.join(root, "dist");
    let source = output.staticDirectory;
    if (!source && !built) source = findStaticDirectory(root);
    if (source) {
      copyStaticAssets(root, source, dist);
      return { mode: built ? mode : "static-copy", command, detection };
    }
    if (fs.existsSync(path.join(dist, "index.html"))) {
      return { mode: "prebuilt", command, detection };
    }
    throw new CliError(
      "PREFLIGHT_NO_BUILD_OUTPUT",
      "No static build output with index.html was found.",
      {
        exitCode: EXIT.PREFLIGHT,
        hint: "Add a build script or a static directory containing index.html.",
        details: {
          framework: detection.framework?.id ?? null,
          expected: detection.outputDirectory,
        },
      },
    );
  }

  const dist = path.join(root, "dist");
  const target = path.join(dist, "server", "index.js");
  if (output.workerEntry && path.resolve(output.workerEntry) !== path.resolve(target)) {
    if (built && !isInside(dist, output.workerEntry)) {
      fs.rmSync(dist, { recursive: true, force: true });
    }
    await bundleWorker({ root, entry: output.workerEntry, output: target });
    return { mode: "worker-bundle", command, detection };
  }
  if (fs.existsSync(target)) {
    return { mode, command, detection };
  }

  const entry = resolveWorkerEntry(root);
  if (entry) {
    await bundleWorker({ root, entry });
    return { mode: "worker-bundle", command, detection };
  }
  throw new CliError("PREFLIGHT_NO_BUILD_OUTPUT", "No Worker entry or build output was found.", {
    exitCode: EXIT.PREFLIGHT,
    hint: "Add a build script that writes dist/server/index.js, or a Worker entry file.",
    details: { framework: detection.framework?.id ?? null },
  });
}

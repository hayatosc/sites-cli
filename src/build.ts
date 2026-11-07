// Build orchestration for `sites deploy` (plan §5.1 step 3), using cf-style
// project detection for the build command and output directory.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import { readManifest } from "./manifest.ts";
import { bundleWorker, resolveWorkerEntry } from "./bundler.ts";
import {
  detectProject,
  findBuildOutput,
  findStaticDirectory,
  packageCommand,
  type ProjectDetection,
} from "./project-detect.ts";
import type { Env } from "./types.ts";

export interface BuildResult {
  mode: "script" | "framework" | "static-copy" | "worker-bundle" | "prebuilt";
  command: string | null;
  detection: ProjectDetection;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runProcess(options: {
  file: string;
  args: string[];
  cwd: string;
  env: Env;
  label: string;
}): Promise<void> {
  const { file, args, cwd, env, label } = options;
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60 * 1000);
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  }).finally(() => clearTimeout(timer));
  if (code !== 0) {
    const tail = output.trim().split("\n").slice(-30).join("\n");
    throw new CliError("BUILD_FAILED", `${label} exited with code ${code}.`, {
      exitCode: EXIT.GENERAL,
      hint: "Fix the build error and retry.",
      details: { command: label, output: tail },
    });
  }
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
  log: (text: string) => void;
}): Promise<BuildResult> {
  const { root, log } = options;
  const env = options.env ?? {};
  const detection = detectProject(root);
  for (const warning of detection.warnings) log(`warning: ${warning}`);

  let mode: BuildResult["mode"] = "prebuilt";
  let command: string | null = null;

  if (!options.noBuildScript) {
    if (detection.buildScript) {
      command = `${detection.packageManager} run ${detection.buildScript}`;
      log(`detected ${detection.framework?.name ?? "package"} project (${command})`);
      log(`running ${command}`);
      await runProcess({
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
      await runProcess({ file: argv[0], args: argv.slice(1), cwd: root, env, label: command });
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

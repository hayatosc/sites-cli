// Build orchestration for `sites deploy` (plan §5.1 step 3).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import { readManifest } from "./manifest.ts";
import type { Env } from "./types.ts";

export interface BuildResult {
  mode: "script" | "static-copy" | "worker-copy";
  command: string | null;
}

function detectPackageManager(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  if (pkg.packageManager) return pkg.packageManager.split("@")[0];
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(root, "aube-lock.yaml"))) return "aube";
  return "npm";
}

async function runBuildScript(root: string, env: Env, log: (text: string) => void): Promise<string> {
  const manager = detectPackageManager(root);
  const command = `${manager} run build`;
  log(`running ${command}`);
  const child = spawn(manager, ["run", "build"], {
    cwd: root,
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
    throw new CliError("BUILD_FAILED", `${command} exited with code ${code}.`, {
      exitCode: EXIT.GENERAL,
      hint: "Fix the build error and retry.",
      details: { command, output: tail },
    });
  }
  return command;
}

export async function buildSite(options: {
  root: string;
  env?: Env;
  noBuildScript: boolean;
  log: (text: string) => void;
}): Promise<BuildResult> {
  const { root, log } = options;
  const packageFile = path.join(root, "package.json");
  let buildScript: string | undefined;
  if (fs.existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { scripts?: Record<string, string> };
      buildScript = pkg.scripts?.build;
    } catch {
      throw new CliError("PREFLIGHT_INVALID_PACKAGE", "package.json is not valid JSON.", {
        exitCode: EXIT.PREFLIGHT,
      });
    }
  }

  if (buildScript && !options.noBuildScript) {
    const command = await runBuildScript(root, options.env ?? {}, log);
    return { mode: "script", command };
  }

  const dist = path.join(root, "dist");
  const manifest = readManifest(root).manifest;
  if (manifest.static) {
    const source = path.join(root, "public");
    if (!fs.existsSync(source)) {
      throw new CliError("PREFLIGHT_NO_BUILD_OUTPUT", "No build script and no public/ directory.", {
        exitCode: EXIT.PREFLIGHT,
        hint: "Add a build script or create public/index.html.",
      });
    }
    fs.rmSync(dist, { recursive: true, force: true });
    fs.cpSync(source, dist, { recursive: true });
    return { mode: "static-copy", command: null };
  }

  const worker = path.join(root, "worker", "index.js");
  if (!fs.existsSync(worker)) {
    throw new CliError("PREFLIGHT_NO_BUILD_OUTPUT", "No build script and no worker/index.js.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Add a build script that writes dist/server/index.js.",
    });
  }
  fs.mkdirSync(path.join(dist, "server"), { recursive: true });
  fs.copyFileSync(worker, path.join(dist, "server", "index.js"));
  return { mode: "worker-copy", command: null };
}

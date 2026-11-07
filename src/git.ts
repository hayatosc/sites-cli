// Git helpers for source synchronization (plan §5.1).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import type { Env } from "./types.ts";
import { redact, registerCleanup, sleep } from "./util.ts";

export class GitError extends Error {
  code: number;
  stdout: string;
  stderr: string;
  args: string[];
  constructor(args: string[], code: number, stdout: string, stderr: string) {
    super(`git ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.args = args;
  }
}

export interface GitOptions {
  cwd: string;
  env?: Env;
  token?: string;
  remoteUrl?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}

const SAFE_OPTIONS = [
  "-c",
  "credential.helper=",
  "-c",
  "http.extraHeader=",
  "-c",
  "http.followRedirects=false",
];

function gitEnv(env: Env, token?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") continue;
    result[key] = value;
  }
  result.GIT_TERMINAL_PROMPT = "0";
  if (token) result.SITES_GIT_AUTHORIZATION = `Authorization: Bearer ${token}`;
  return result;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(args: string[], options: GitOptions): Promise<GitResult> {
  const prefix = [...SAFE_OPTIONS];
  if (options.token && options.remoteUrl) {
    prefix.push(`--config-env=http.${options.remoteUrl}.extraHeader=SITES_GIT_AUTHORIZATION`);
  }
  const fullArgs = [...prefix, ...args];
  const child = spawn("git", fullArgs, {
    cwd: options.cwd,
    env: gitEnv(options.env ?? {}, options.token),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  }).finally(() => clearTimeout(timer));

  const safeOut = options.token ? redact(stdout, [options.token]) : stdout;
  const safeErr = options.token ? redact(stderr, [options.token]) : stderr;
  if (code !== 0 && !options.allowFailure) {
    throw new GitError(args, code, safeOut, safeErr);
  }
  return { stdout: safeOut, stderr: safeErr, code };
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await git(["--version"], { cwd: os.tmpdir(), allowFailure: false });
    return true;
  } catch {
    return false;
  }
}

export async function isInsideGitRepo(root: string): Promise<boolean> {
  try {
    const result = await git(["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      allowFailure: true,
    });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function currentHead(root: string): Promise<string | null> {
  try {
    const result = await git(["rev-parse", "HEAD"], { cwd: root, allowFailure: true });
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function dirtyFiles(root: string): Promise<string[]> {
  if (!(await isInsideGitRepo(root))) return [];
  const result = await git(["status", "--porcelain"], { cwd: root, allowFailure: true });
  return result.stdout.split("\n").filter(Boolean);
}

export function assertHttpsRemote(remoteUrl: string, env: Env = process.env as Env): void {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new CliError(
      "PREFLIGHT_INVALID_SOURCE_URL",
      `Invalid source repository URL: ${remoteUrl}`,
      {
        exitCode: EXIT.PREFLIGHT,
      },
    );
  }
  const insecureAllowed = env.SITES_ALLOW_INSECURE_GIT === "1";
  if (url.protocol !== "https:" && !(insecureAllowed && url.protocol === "file:")) {
    throw new CliError("PREFLIGHT_INVALID_SOURCE_URL", "The source repository must use HTTPS.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Use the remote_url returned by the Sites API.",
    });
  }
  if (url.username || url.password) {
    throw new CliError(
      "PREFLIGHT_INVALID_SOURCE_URL",
      "The source repository URL must not contain credentials.",
      {
        exitCode: EXIT.PREFLIGHT,
      },
    );
  }
}

/** Copies the project working tree into a temporary directory (excluding build output). */
async function projectFiles(root: string): Promise<string[]> {
  if (await isInsideGitRepo(root)) {
    const result = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      allowFailure: false,
    });
    return result.stdout.split("\0").filter((file) => file && fs.existsSync(path.join(root, file)));
  }
  const files: string[] = [];
  const skip = new Set([".git", "node_modules", "dist", ".sites", "outputs", ".DS_Store"]);
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else files.push(next);
    }
  };
  walk("");
  return files;
}

function overlay(sourceRoot: string, targetRoot: string, files: string[]): void {
  for (const file of files) {
    const target = path.join(targetRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file), target);
    const mode = fs.statSync(path.join(sourceRoot, file)).mode;
    fs.chmodSync(target, mode);
  }
}

export interface SourceSyncOptions {
  root: string;
  env?: Env;
  remoteUrl: string;
  branch: string;
  token: string;
  message: string;
  /** True when the build artifact changed but the source tree did not. */
  advanceSha: boolean;
  log?: (text: string) => void;
}

export interface SourceSyncResult {
  commitSha: string;
  branch: string;
  pushed: boolean;
  files: number;
}

export async function syncSource(options: SourceSyncOptions): Promise<SourceSyncResult> {
  assertHttpsRemote(options.remoteUrl, options.env);
  if (!(await gitAvailable())) {
    throw new CliError("PREFLIGHT_GIT_MISSING", "git is required for source synchronization.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Install git or deploy with --no-source-sync.",
    });
  }
  const files = await projectFiles(options.root);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sites-source-"));
  registerCleanup(() => fs.rmSync(temp, { recursive: true, force: true }));
  try {
    await git(["init", "--initial-branch", options.branch], { cwd: temp, allowFailure: false });
    const ref = `refs/heads/${options.branch}`;
    const remote = await git(["ls-remote", "--heads", options.remoteUrl, ref], {
      cwd: temp,
      env: options.env,
      token: options.token,
      remoteUrl: options.remoteUrl,
      allowFailure: true,
    });
    const remoteSha = remote.stdout.trim().split(/\s+/)[0] || null;

    if (remoteSha) {
      await git(["fetch", "--no-tags", options.remoteUrl, ref], {
        cwd: temp,
        env: options.env,
        token: options.token,
        remoteUrl: options.remoteUrl,
      });
      await git(["reset", "--hard", "FETCH_HEAD"], { cwd: temp, allowFailure: false });
    }
    overlay(options.root, temp, files);
    await git(["add", "--all"], { cwd: temp, allowFailure: false });

    const staged = await git(["diff", "--cached", "--quiet"], { cwd: temp, allowFailure: true });
    const hasChanges = staged.code !== 0;

    if (!hasChanges && remoteSha && !options.advanceSha) {
      options.log?.(`source unchanged (${remoteSha.slice(0, 8)})`);
      return { commitSha: remoteSha, branch: options.branch, pushed: false, files: files.length };
    }

    const identity = ["-c", "user.name=sites", "-c", "user.email=sites@localhost"];
    if (hasChanges || !remoteSha) {
      await git([...identity, "commit", "-m", options.message], { cwd: temp, allowFailure: false });
    } else {
      await git([...identity, "commit", "--allow-empty", "-m", options.message], {
        cwd: temp,
        allowFailure: false,
      });
    }

    const head = await git(["rev-parse", "HEAD"], { cwd: temp, allowFailure: false });
    const commitSha = head.stdout.trim();
    try {
      await git(["push", options.remoteUrl, `HEAD:${ref}`], {
        cwd: temp,
        env: options.env,
        token: options.token,
        remoteUrl: options.remoteUrl,
        timeoutMs: 180_000,
      });
    } catch (error) {
      if (error instanceof GitError) {
        throw new CliError("CONFLICT_DIVERGED", "Site source changed while saving.", {
          exitCode: EXIT.CONFLICT,
          hint: "Run `sites doctor --fix-git` for guidance, then retry.",
          details: { stderr: error.stderr.trim() },
        });
      }
      throw error;
    }

    const verify = await git(["ls-remote", "--heads", options.remoteUrl, ref], {
      cwd: temp,
      env: options.env,
      token: options.token,
      remoteUrl: options.remoteUrl,
    });
    const verifiedSha = verify.stdout.trim().split(/\s+/)[0] || "";
    if (verifiedSha !== commitSha) {
      throw new CliError("CONFLICT_DIVERGED", "Site source changed while saving.", {
        exitCode: EXIT.CONFLICT,
        hint: "Another push reached the source repository first. Retry the deploy.",
      });
    }
    const status = await git(["status", "--porcelain"], { cwd: temp, allowFailure: false });
    if (status.stdout.trim()) {
      throw new CliError("CONFLICT_DIVERGED", "Site source changed while saving.", {
        exitCode: EXIT.CONFLICT,
      });
    }
    return { commitSha, branch: options.branch, pushed: true, files: files.length };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Creates an empty source commit so save_site_version does not deduplicate. */
export async function emptyCommit(root: string, message: string): Promise<string> {
  await git(
    [
      "-c",
      "user.name=sites",
      "-c",
      "user.email=sites@localhost",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ],
    {
      cwd: root,
      allowFailure: false,
    },
  );
  return (await currentHead(root)) ?? "";
}

/** Retries a git operation that can fail transiently. */
export async function withGitRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (index + 1 < attempts) await sleep(250 * (index + 1));
    }
  }
  throw last;
}

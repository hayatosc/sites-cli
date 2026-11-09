// `sites doctor` (plan §4).

import fs from "node:fs";
import path from "node:path";
import type { CommandResult, DefineCommand } from "../types.ts";
import type { DeploymentRecord, SiteRecord } from "../api-types.ts";
import { authFilePath, decodeJwtExpiry } from "../auth.ts";
import { inspectDist } from "../package-site.ts";
import { findWranglerConfig } from "../wrangler.ts";
import { readManifest, readState, type Manifest } from "../manifest.ts";
import { CliError } from "../errors.ts";
import { currentHead, dirtyFiles, gitAvailable, isInsideGitRepo } from "../git.ts";

type CheckStatus = "ok" | "warn" | "fail" | "skip";

interface DoctorCheck {
  id: number;
  name: string;
  status: CheckStatus;
  detail: string;
}

interface DoctorData {
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
  offline: boolean;
}

const MANIFEST_KEYS = new Set([
  "project_id",
  "static",
  "d1",
  "r2",
  "capabilities",
  "plugins",
  "connectors",
]);
const STATIC_KEYS = new Set(["directory", "not_found_handling"]);
const UNSUPPORTED_WRANGLER = [
  "kv_namespaces",
  "durable_objects",
  "queues",
  "services",
  "hyperdrive",
  "vectorize",
  "ai",
  "browser",
  "rules",
];

function check(id: number, name: string, status: CheckStatus, detail: string): DoctorCheck {
  return { id, name, status, detail };
}

function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function manifestProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) problems.push(`unknown key: ${key}`);
  }
  if (manifest.static !== undefined && manifest.static !== null) {
    if (typeof manifest.static !== "object") problems.push("static must be an object");
    else {
      for (const key of Object.keys(manifest.static as Record<string, unknown>)) {
        if (!STATIC_KEYS.has(key)) problems.push(`unknown static key: ${key}`);
      }
      if (typeof (manifest.static as { directory?: unknown }).directory !== "string") {
        problems.push("static.directory must be a string");
      }
    }
  }
  if (manifest.d1 !== undefined && manifest.d1 !== null && typeof manifest.d1 !== "string") {
    problems.push("d1 must be a binding name");
  }
  if (manifest.r2 !== undefined && manifest.r2 !== null && typeof manifest.r2 !== "string") {
    problems.push("r2 must be a binding name");
  }
  if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) {
    problems.push("capabilities must be an array");
  }
  return problems;
}

async function checkAuth(env: Record<string, string | undefined>): Promise<DoctorCheck> {
  if (env.SITES_ACCESS_TOKEN) {
    return check(2, "Codex auth", "ok", "SITES_ACCESS_TOKEN is set; the Codex file is not used.");
  }
  const file = authFilePath(env);
  if (!fs.existsSync(file)) {
    return check(2, "Codex auth", "fail", `${file} does not exist.`);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      tokens?: { access_token?: string };
    };
    const token = parsed.tokens?.access_token;
    if (!token) return check(2, "Codex auth", "fail", "auth.json has no access token.");
    const expiry = decodeJwtExpiry(token);
    if (expiry !== null && expiry < Date.now()) {
      return check(
        2,
        "Codex auth",
        "warn",
        "The access token is expired; it will be refreshed on demand.",
      );
    }
    return check(2, "Codex auth", "ok", `Codex credentials found at ${file}.`);
  } catch {
    return check(2, "Codex auth", "fail", "auth.json is not valid JSON.");
  }
}

export function registerDoctorCommands(define: DefineCommand): void {
  define({
    path: ["doctor"],
    flags: ["offline", "verbose"],
    positionals: { min: 0, max: 0 },
    summary: "Check the local project and connection",
    usage: "sites doctor [--offline] [--verbose]",
    run: async (ctx): Promise<CommandResult<DoctorData>> => {
      const offline = Boolean(ctx.options.offline);
      const checks: DoctorCheck[] = [];

      checks.push(
        nodeVersionOk(process.versions.node)
          ? check(1, "Node.js version", "ok", process.versions.node)
          : check(1, "Node.js version", "fail", `${process.versions.node} < 22.13`),
      );
      const authCheck = await checkAuth(ctx.env);
      checks.push(authCheck);

      let manifest: Manifest | null = null;
      let projectId: string | null = null;
      try {
        const loaded = readManifest(ctx.root);
        manifest = loaded.manifest;
        projectId = (manifest.project_id as string | null) ?? null;
        const problems = manifestProblems(manifest);
        checks.push(
          problems.length
            ? check(4, "hosting.json", "fail", problems.join("; "))
            : check(4, "hosting.json", "ok", "Manifest keys are valid."),
        );
      } catch (error) {
        const message = error instanceof CliError ? error.message : (error as Error).message;
        checks.push(check(4, "hosting.json", "warn", message));
      }

      const wrangler = findWranglerConfig(ctx.root);
      if (!wrangler) {
        checks.push(check(6, "wrangler", "ok", "No wrangler configuration to convert."));
      } else {
        const unsupported = UNSUPPORTED_WRANGLER.filter((key) => {
          const value = wrangler.config[key];
          return Array.isArray(value) ? value.length > 0 : Boolean(value);
        });
        checks.push(
          unsupported.length
            ? check(6, "wrangler", "fail", `Unsupported sections: ${unsupported.join(", ")}`)
            : check(6, "wrangler", "ok", `${wrangler.relative} can be converted.`),
        );
      }

      if (manifest) {
        try {
          const dist = inspectDist(ctx.root, manifest);
          checks.push(check(7, "dist", "ok", `${dist.kind} artifact, ${dist.fileCount} files.`));
        } catch (error) {
          const message = error instanceof CliError ? error.message : (error as Error).message;
          const missing = !fs.existsSync(path.join(ctx.root, "dist"));
          checks.push(check(7, "dist", missing ? "warn" : "fail", message));
        }
      } else {
        checks.push(check(7, "dist", "skip", "No manifest to validate against."));
      }

      const hasGit = await gitAvailable();
      checks.push(
        hasGit
          ? check(9, "git", "ok", "git is available.")
          : check(9, "git", "fail", "git is not installed; source sync cannot run."),
      );

      if (hasGit) {
        const inRepo = await isInsideGitRepo(ctx.root);
        if (!inRepo) {
          checks.push(
            check(
              8,
              "git history",
              "warn",
              "Not a git repository; source sync uses a temporary clone.",
            ),
          );
        } else {
          const dirty = await dirtyFiles(ctx.root);
          const head = await currentHead(ctx.root);
          const detail = `${head ? head.slice(0, 12) : "no commits"}; ${dirty.length} uncommitted file(s).`;
          checks.push(check(8, "git history", dirty.length ? "warn" : "ok", detail));
        }
      } else {
        checks.push(check(8, "git history", "skip", "git is unavailable."));
      }

      let hasBuild = false;
      const packageFile = path.join(ctx.root, "package.json");
      if (fs.existsSync(packageFile)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as {
            scripts?: Record<string, string>;
          };
          hasBuild = Boolean(pkg.scripts?.build);
        } catch {
          hasBuild = false;
        }
      }
      checks.push(
        hasBuild
          ? check(10, "build script", "ok", "package.json has a build script.")
          : check(
              10,
              "build script",
              "warn",
              "No build script; static public/ or a Worker entry is used.",
            ),
      );

      const state = readState(ctx.root);
      const recent429 =
        typeof state.last_rate_limited_at === "string"
          ? Date.parse(state.last_rate_limited_at)
          : NaN;
      checks.push(
        Number.isFinite(recent429) && Date.now() - recent429 < 15 * 60 * 1000
          ? check(11, "rate limit", "warn", "A 429 was recorded in the last 15 minutes.")
          : check(11, "rate limit", "ok", "No recent 429 recorded."),
      );

      if (offline) {
        checks.push(check(3, "MCP connection", "skip", "Skipped by --offline."));
        checks.push(check(5, "project ownership", "skip", "Skipped by --offline."));
        checks.push(check(12, "deployment state", "skip", "Skipped by --offline."));
      } else {
        try {
          const info = await ctx.mcp().initialize();
          checks.push(
            check(
              3,
              "MCP connection",
              "ok",
              `server: ${info.serverInfo?.name ?? "plugin-runtime"}`,
            ),
          );
        } catch (error) {
          checks.push(check(3, "MCP connection", "fail", (error as Error).message));
        }
        if (!projectId) {
          checks.push(check(5, "project ownership", "skip", "hosting.json has no project_id."));
        } else if (authCheck.status === "fail") {
          checks.push(check(5, "project ownership", "skip", "Codex credentials are unavailable."));
        } else {
          try {
            const site = await ctx.mcp().callTool<SiteRecord>("sites.get_site", {
              project_id: projectId,
            });
            const remoteId = site.id ?? site.project_id;
            checks.push(
              remoteId === projectId
                ? check(5, "project ownership", "ok", `${site.slug ?? projectId} is reachable.`)
                : check(
                    5,
                    "project ownership",
                    "fail",
                    `API returned ${remoteId ?? "no id"}, expected ${projectId}.`,
                  ),
            );
          } catch (error) {
            checks.push(check(5, "project ownership", "fail", (error as Error).message));
          }
        }
        if (!state.last_deployment_id) {
          checks.push(check(12, "deployment state", "warn", "No recorded deployment."));
        } else if (authCheck.status === "fail") {
          checks.push(check(12, "deployment state", "skip", "Codex credentials are unavailable."));
        } else {
          try {
            const deployment = await ctx
              .mcp()
              .callTool<DeploymentRecord>("sites.get_deployment_status", {
                project_id: projectId,
                deployment_id: state.last_deployment_id,
              });
            checks.push(
              check(
                12,
                "deployment state",
                "ok",
                `${state.last_deployment_id}: ${deployment.status ?? "unknown"}`,
              ),
            );
          } catch (error) {
            checks.push(check(12, "deployment state", "fail", (error as Error).message));
          }
        }
      }

      const failures = checks.filter((entry) => entry.status === "fail").length;
      const warnings = checks.filter((entry) => entry.status === "warn").length;
      return {
        data: { checks, failures, warnings, offline },
        exitCode: failures ? 1 : 0,
        human: (value) => {
          for (const entry of value.checks) {
            const mark =
              entry.status === "ok"
                ? "✓"
                : entry.status === "warn"
                  ? "!"
                  : entry.status === "skip"
                    ? "-"
                    : "✗";
            ctx.stdout.write(
              `${mark} ${String(entry.id).padStart(2)} ${entry.name}${ctx.options.verbose || entry.status !== "ok" ? `: ${entry.detail}` : ""}\n`,
            );
          }
          ctx.stdout.write(`${value.failures} failure(s), ${value.warnings} warning(s)\n`);
        },
      };
    },
  });
}

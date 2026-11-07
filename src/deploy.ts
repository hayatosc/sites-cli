// `sites deploy` orchestration (plan §5).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildSite } from "./build.ts";
import { createArchive, inspectDist } from "./package-site.ts";
import type { SiteKind } from "./package-site.ts";
import { currentHead, dirtyFiles, syncSource } from "./git.ts";
import { uploadArchive } from "./upload.ts";
import { pollDeployment } from "./deployment.ts";
import { readManifest, readState, writeState } from "./manifest.ts";
import type { LocalState } from "./manifest.ts";
import { CliError, EXIT } from "./errors.ts";
import type { DeploymentRecord, SiteRecord, SiteVersionRecord, SourceCredential } from "./api-types.ts";
import type { CommandContext } from "./types.ts";
import { stringOption } from "./util.ts";

export interface DeployData {
  project_id: string;
  version_id: string | null;
  version_number: number | null;
  deployment_id: string | null;
  status: string;
  url: string | null;
  commit_sha: string | null;
  access_mode: string;
  kind?: SiteKind;
  commit_pushed?: boolean;
  archive?: { size_bytes: number; file_count: number };
  dry_run?: boolean;
}

function accessModeFromFlags(ctx: CommandContext): "custom" | "public" | "workspace_all" | null {
  const requested = [ctx.options.private ? "custom" : null, ctx.options.public ? "public" : null, ctx.options.workspace ? "workspace_all" : null]
    .filter(Boolean) as Array<"custom" | "public" | "workspace_all">;
  if (requested.length > 1) {
    throw new CliError("USAGE_CONFLICTING_FLAGS", "Choose only one of --private, --public, or --workspace.", {
      exitCode: EXIT.USAGE,
    });
  }
  return requested[0] ?? null;
}

async function confirmPublic(ctx: CommandContext): Promise<void> {
  if (ctx.yes) return;
  if (!process.stdin.isTTY) {
    throw new CliError("CONFIRM_REQUIRED", "Publishing a site requires confirmation.", {
      exitCode: EXIT.USAGE,
      hint: "Re-run with --yes to publish without a prompt.",
    });
  }
  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Publish this site publicly? [y/N] ", (value) => {
      rl.close();
      resolve(value.trim().toLowerCase());
    });
  });
  if (answer !== "y" && answer !== "yes") {
    throw new CliError("CANCELLED", "Deploy cancelled.", { exitCode: EXIT.INTERRUPT });
  }
}

function readEnvFile(root: string, file: string): Array<{ key: string; value: string }> {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file);
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch {
    throw new CliError("PREFLIGHT_ENV_FILE", `Cannot read env file: ${file}`, { exitCode: EXIT.PREFLIGHT });
  }
  const entries: Array<{ key: string; value: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equal = trimmed.indexOf("=");
    if (equal <= 0) {
      throw new CliError("PREFLIGHT_ENV_FILE", `Invalid env file line: ${trimmed}`, {
        exitCode: EXIT.PREFLIGHT,
        hint: "Use KEY=VALUE lines.",
      });
    }
    const key = trimmed.slice(0, equal).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError("PREFLIGHT_ENV_FILE", `Invalid environment variable name: ${key}`, {
        exitCode: EXIT.PREFLIGHT,
      });
    }
    entries.push({ key, value: trimmed.slice(equal + 1) });
  }
  return entries;
}

function credentialOf(value: SourceCredential | null | undefined, projectId: string): SourceCredential {
  if (!value?.remote_url) {
    throw new CliError("PREFLIGHT_NO_SOURCE_CREDENTIAL", "The source repository credential is missing.", {
      exitCode: EXIT.PREFLIGHT,
      details: { project_id: projectId },
    });
  }
  return value;
}

export async function runDeploy(ctx: CommandContext): Promise<DeployData> {
  const manifest = readManifest(ctx.root).manifest;
  if (!manifest.project_id) {
    throw new CliError("PREFLIGHT_NO_PROJECT", "hosting.json has no project_id.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run `sites create <slug>` first.",
    });
  }
  const projectId = manifest.project_id;
  const dryRun = Boolean(ctx.options["dry-run"]);
  const allowDirty = Boolean(ctx.options["allow-dirty"]);
  const timeout = Number(ctx.options.timeout ?? 300);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new CliError("USAGE_INVALID_VALUE", `Invalid --timeout value: ${String(ctx.options.timeout)}`, {
      exitCode: EXIT.USAGE,
    });
  }
  const requestedAccess = accessModeFromFlags(ctx);
  const message = stringOption(ctx.options, "message") ?? "Update Site source";

  ctx.log("[1/7] Preflight");
  const dirty = await dirtyFiles(ctx.root);
  if (dirty.length && !allowDirty) {
    throw new CliError("CONFLICT_DIRTY_TREE", "The working tree has uncommitted changes.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Commit the changes or pass --allow-dirty.",
      details: { files: dirty.slice(0, 20) },
    });
  }
  ctx.log("[2/7] Build");
  const build = await buildSite({
    root: ctx.root,
    env: ctx.env,
    noBuildScript: Boolean(ctx.options["no-build-script"]),
    log: ctx.log,
  });
  const dist = inspectDist(ctx.root, manifest);

  if (dryRun) {
    ctx.log(`[3/7] Dry run (${dist.kind}: ${dist.entry}, ${dist.fileCount} files)`);
    ctx.log(`build: ${build.mode}${build.command ? ` (${build.command})` : ""}`);
    return {
      project_id: projectId,
      version_id: null,
      version_number: null,
      deployment_id: null,
      status: "dry-run",
      url: null,
      commit_sha: null,
      access_mode: requestedAccess ?? "unchanged",
      kind: dist.kind,
      archive: { size_bytes: dist.sizeBytes, file_count: dist.fileCount },
      dry_run: true,
    };
  }

  const state = readState(ctx.root);
  const advanceSha = Boolean(state.last_artifact_hash && state.last_artifact_hash !== dist.treeHash);

  const client = ctx.mcp();
  await client.initialize();
  const site = await client.callTool<SiteRecord>("sites.get_site", { project_id: projectId });
  const currentAccess = site.access_mode ?? "custom";
  const targetAccess = requestedAccess ?? currentAccess;
  if (targetAccess === "public" && currentAccess !== "public") {
    await confirmPublic(ctx);
  }

  ctx.log("[3/7] Source sync");
  let commitSha: string | null = null;
  let pushed = false;
  if (ctx.options["no-source-sync"]) {
    commitSha = (await currentHead(ctx.root)) ?? state.last_commit_sha ?? null;
    if (!commitSha) {
      throw new CliError("PREFLIGHT_NO_COMMIT", "No commit SHA is available for --no-source-sync.", {
        exitCode: EXIT.PREFLIGHT,
        hint: "Push the source repository once, or omit --no-source-sync.",
      });
    }
    ctx.log(`source sync skipped (${commitSha.slice(0, 8)})`);
  } else {
    const credential = credentialOf(
      await client.callTool<SourceCredential>("sites.create_source_repository_write_credential", {
        project_id: projectId,
      }),
      projectId,
    );
    if (!credential.token) {
      throw new CliError("AUTH_UNAUTHORIZED", "The source repository credential has no token.", {
        exitCode: EXIT.AUTH,
      });
    }
    if (credential.token_expires_at && Date.parse(credential.token_expires_at) < Date.now()) {
      throw new CliError("AUTH_EXPIRED", "The source repository credential has expired.", {
        exitCode: EXIT.AUTH,
        hint: "Retry the deploy to obtain a fresh credential.",
      });
    }
    const synced = await syncSource({
      root: ctx.root,
      env: ctx.env,
      remoteUrl: credential.remote_url ?? "",
      branch: credential.branch || "main",
      token: credential.token,
      message,
      advanceSha,
      log: ctx.log,
    });
    commitSha = synced.commitSha;
    pushed = synced.pushed;
    ctx.log(`source ${pushed ? "pushed" : "unchanged"} (${commitSha.slice(0, 8)} → ${synced.branch})`);
  }

  ctx.log("[4/7] Package");
  const archive = await createArchive(ctx.root);
  ctx.log(`${archive.fileCount} files, ${archive.sizeBytes} bytes`);

  ctx.log("[5/7] Upload");
  const uploaded = await uploadArchive({
    archiveFile: archive.archiveFile,
    projectId,
    token: ctx.getIdentity().token,
    env: ctx.env,
    log: ctx.log,
  });
  fs.rmSync(path.dirname(archive.archiveFile), { recursive: true, force: true });

  ctx.log("[6/7] Save version");
  const version = await client.callTool<SiteVersionRecord>("sites.save_site_version", {
    project_id: projectId,
    commit_sha: commitSha,
    archive: uploaded,
  });
  if (!version.id) {
    throw new CliError("INTERNAL_ERROR", "save_site_version returned no version id.");
  }

  if (ctx.options["env-file"]) {
    const values = readEnvFile(ctx.root, String(ctx.options["env-file"]));
    if (values.length) {
      await client.callTool("sites.update_environment_variables", {
        project_id: projectId,
        set_values: values.map((entry) => ({ ...entry, is_secret: false, type: "envvar" })),
        remove: [],
      });
    }
  }

  ctx.log("[7/7] Deploy");
  const tool = currentAccess === "custom" ? "sites.deploy_private_site_version" : "sites.deploy_site_version";
  const deployment = await client.callTool<DeploymentRecord>(tool, {
    project_id: projectId,
    version_id: version.id,
  });
  const deploymentId = deployment.id ?? (deployment.deployment_id as string | undefined);
  if (!deploymentId) {
    throw new CliError("INTERNAL_ERROR", "The deploy tool returned no deployment id.");
  }

  const final = await pollDeployment(ctx, {
    projectId,
    deploymentId,
    timeoutSeconds: timeout,
    log: ctx.log,
  });

  let accessMode = currentAccess;
  if (targetAccess !== currentAccess) {
    await client.callTool("sites.update_site_access", { project_id: projectId, access_mode: targetAccess });
    accessMode = targetAccess;
  }

  const nextState: LocalState = {
    ...state,
    last_deployment_id: deploymentId,
    last_version_id: version.id,
    last_commit_sha: commitSha ?? undefined,
    last_artifact_hash: dist.treeHash,
    updated_at: new Date().toISOString(),
  };
  const tag = stringOption(ctx.options, "tag");
  if (tag) nextState.tags = { ...(state.tags ?? {}), [tag]: version.id };
  writeState(ctx.root, nextState);

  return {
    project_id: projectId,
    version_id: version.id,
    version_number: version.version_number ?? null,
    deployment_id: deploymentId,
    status: final.status ?? "succeeded",
    url: final.url ?? site.url ?? site.current_live_url ?? null,
    commit_sha: commitSha,
    access_mode: accessMode,
    kind: dist.kind,
    commit_pushed: pushed,
    archive: { size_bytes: archiveSizeOf(archive), file_count: archive.fileCount },
  };
}

function archiveSizeOf(archive: { archiveSize: number }): number {
  return archive.archiveSize;
}

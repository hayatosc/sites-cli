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
import { MANIFEST_DIR, MANIFEST_NAME, readManifest, readState, writeState } from "./manifest.ts";
import type { LocalState } from "./manifest.ts";
import { convertWranglerProject } from "./convert.ts";
import type { ConversionReport } from "./convert.ts";
import { CliError, EXIT } from "./errors.ts";
import type {
  DeploymentRecord,
  SiteRecord,
  SiteVersionRecord,
  SourceCredential,
} from "./api-types.ts";
import type { CommandContext } from "./types.ts";
import { stringListOption, stringOption } from "./util.ts";
import { integerOption } from "./args.ts";
import { readEnvFile, readSecretsFile } from "./env-file.ts";
import type { ProjectDetection } from "./project-detect.ts";

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
  conversion?: ConversionReport;
  detection?: Record<string, unknown>;
  environment?: { keys: string[]; secret_keys: string[] };
}

function detectionReport(detection: ProjectDetection, siteKind: SiteKind): Record<string, unknown> {
  return {
    framework: detection.framework
      ? {
          id: detection.framework.id,
          name: detection.framework.name,
          build_command: detection.framework.buildCommand,
          output_directory: detection.framework.outputDirectory,
          kind: detection.framework.kind,
        }
      : null,
    package_manager: detection.packageManager,
    build_script: detection.buildScript,
    build_command: detection.buildCommand,
    output_directory: detection.outputDirectory,
    kind: siteKind,
    warnings: detection.warnings,
  };
}

function accessModeFromFlags(ctx: CommandContext): "custom" | "public" | "workspace_all" | null {
  const requested = [
    ctx.options.private ? "custom" : null,
    ctx.options.public ? "public" : null,
    ctx.options.workspace ? "workspace_all" : null,
  ].filter(Boolean) as Array<"custom" | "public" | "workspace_all">;
  if (requested.length > 1) {
    throw new CliError(
      "USAGE_CONFLICTING_FLAGS",
      "Choose only one of --private, --public, or --workspace.",
      {
        exitCode: EXIT.USAGE,
      },
    );
  }
  return requested[0] ?? null;
}

async function confirmPublic(ctx: CommandContext): Promise<void> {
  if (ctx.options.force) return;
  if (!process.stdin.isTTY) {
    throw new CliError("CONFIRM_REQUIRED", "Publishing a site requires confirmation.", {
      exitCode: EXIT.USAGE,
      hint: "Re-run with --force to publish without a prompt.",
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

function conversionVariables(root: string): Array<{ key: string; value: string }> {
  const file = path.join(root, ".sites", "conversion.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { vars?: Record<string, unknown> };
    return Object.entries(parsed.vars ?? {}).map(([key, value]) => ({ key, value: String(value) }));
  } catch {
    return [];
  }
}

function credentialOf(
  value: SourceCredential | null | undefined,
  projectId: string,
): SourceCredential {
  if (!value?.remote_url) {
    throw new CliError(
      "PREFLIGHT_NO_SOURCE_CREDENTIAL",
      "The source repository credential is missing.",
      {
        exitCode: EXIT.PREFLIGHT,
        details: { project_id: projectId },
      },
    );
  }
  return value;
}

export async function runDeploy(
  ctx: CommandContext,
  options: { uploadOnly?: boolean } = {},
): Promise<DeployData> {
  const dryRun = Boolean(ctx.options["dry-run"]);
  const allowDirty = Boolean(ctx.options["allow-dirty"]);
  const timeout = integerOption(ctx.options, "timeout", { min: 1, max: 86_400, fallback: 300 });
  const requestedAccess = accessModeFromFlags(ctx);
  const message = stringOption(ctx.options, "message") ?? "Update Site source";

  ctx.log("Preflight");
  const dirty = await dirtyFiles(ctx.root);
  if (dirty.length && !allowDirty) {
    throw new CliError("CONFLICT_DIRTY_TREE", "The working tree has uncommitted changes.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Commit the changes or pass --allow-dirty.",
      details: { files: dirty.slice(0, 20) },
    });
  }

  let conversion: ConversionReport | null = null;
  if (!fs.existsSync(path.join(ctx.root, MANIFEST_DIR, MANIFEST_NAME))) {
    conversion = await convertWranglerProject({
      root: ctx.root,
      allowUnsupported: stringListOption(ctx.options, "allow-unsupported"),
      log: ctx.log,
    });
  }

  const manifest = readManifest(ctx.root).manifest;
  if (!manifest.project_id) {
    throw new CliError("PREFLIGHT_NO_PROJECT", "hosting.json has no project_id.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run `sites create <slug>` first.",
    });
  }
  const projectId = manifest.project_id;
  ctx.log("Build");
  const build = await buildSite({
    root: ctx.root,
    env: ctx.env,
    prebuilt: Boolean(ctx.options.prebuilt),
    noBuildScript: Boolean(ctx.options["no-build-script"]),
    log: ctx.log,
    output: ctx.stderr,
    quiet: ctx.quiet,
  });
  const dist = inspectDist(ctx.root, manifest);
  ctx.success(build.mode === "prebuilt" ? "Build output ready" : "Build complete");

  const mergedValues = new Map<string, { key: string; value: string; is_secret: boolean }>();
  for (const entry of options.uploadOnly ? [] : conversionVariables(ctx.root)) {
    mergedValues.set(entry.key, { ...entry, is_secret: false });
  }
  const envFile = stringOption(ctx.options, "env-file");
  if (envFile) {
    for (const entry of readEnvFile(ctx.root, envFile)) {
      mergedValues.set(entry.key, { ...entry, is_secret: false });
    }
  }
  const secretsFile = stringOption(ctx.options, "secrets-file");
  if (secretsFile) {
    for (const entry of readSecretsFile(ctx.root, secretsFile, ctx.env)) {
      mergedValues.set(entry.key, { ...entry, is_secret: true });
    }
  }
  const values = [...mergedValues.values()];
  const environment = {
    keys: values.map((entry) => entry.key),
    secret_keys: values.filter((entry) => entry.is_secret).map((entry) => entry.key),
  };

  if (dryRun) {
    ctx.log(`Dry run (${dist.kind}: ${dist.entry}, ${dist.fileCount} files)`);
    ctx.log(`build: ${build.mode}${build.command ? ` (${build.command})` : ""}`);
    ctx.success("Dry run complete");
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
      detection: detectionReport(build.detection, dist.kind),
      environment,
      ...(conversion ? { conversion } : {}),
    };
  }

  const state = readState(ctx.root);
  const previousHash = state.last_uploaded_artifact_hash ?? state.last_artifact_hash;
  const advanceSha = Boolean(previousHash && previousHash !== dist.treeHash);

  const client = ctx.mcp();
  await client.initialize();
  const site = await client.callTool<SiteRecord>("sites.get_site", { project_id: projectId });
  const currentAccess = site.access_mode ?? "custom";
  const targetAccess = requestedAccess ?? currentAccess;
  if (!options.uploadOnly && targetAccess === "public" && currentAccess !== "public") {
    await confirmPublic(ctx);
  }

  ctx.log("Source sync");
  let commitSha: string | null = null;
  let pushed = false;
  if (ctx.options["no-source-sync"]) {
    commitSha =
      (await currentHead(ctx.root)) ??
      state.last_uploaded_commit_sha ??
      state.last_commit_sha ??
      null;
    if (!commitSha) {
      throw new CliError(
        "PREFLIGHT_NO_COMMIT",
        "No commit SHA is available for --no-source-sync.",
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Push the source repository once, or omit --no-source-sync.",
        },
      );
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
    ctx.log(
      `source ${pushed ? "pushed" : "unchanged"} (${commitSha.slice(0, 8)} → ${synced.branch})`,
    );
  }

  ctx.log("Package");
  const archive = await createArchive(ctx.root);
  ctx.log(`${archive.fileCount} files, ${archive.sizeBytes} bytes`);

  ctx.log("Upload");
  const uploaded = await (async () => {
    try {
      return await uploadArchive({
        archiveFile: archive.archiveFile,
        projectId,
        token: ctx.getIdentity().token,
        env: ctx.env,
        log: ctx.log,
      });
    } finally {
      fs.rmSync(path.dirname(archive.archiveFile), { recursive: true, force: true });
    }
  })();

  ctx.log("Save version");
  const version = await client.callTool<SiteVersionRecord>("sites.save_site_version", {
    project_id: projectId,
    commit_sha: commitSha,
    archive: uploaded,
  });
  if (!version.id) {
    throw new CliError("INTERNAL_ERROR", "save_site_version returned no version id.");
  }

  const tag = stringOption(ctx.options, "tag");
  const uploadedState: LocalState = {
    ...state,
    last_uploaded_version_id: version.id,
    last_uploaded_commit_sha: commitSha ?? undefined,
    last_uploaded_artifact_hash: dist.treeHash,
    ...(tag ? { tags: { ...state.tags, [tag]: version.id } } : {}),
    updated_at: new Date().toISOString(),
  };
  writeState(ctx.root, uploadedState);
  if (options.uploadOnly) {
    ctx.success("Version uploaded (not deployed)");
    return {
      project_id: projectId,
      version_id: version.id,
      version_number: version.version_number ?? null,
      deployment_id: null,
      status: "uploaded",
      url: null,
      commit_sha: commitSha,
      access_mode: currentAccess,
      kind: dist.kind,
      commit_pushed: pushed,
      archive: { size_bytes: archive.archiveSize, file_count: archive.fileCount },
      detection: detectionReport(build.detection, dist.kind),
    };
  }

  if (values.length) {
    await client.callTool("sites.update_environment_variables", {
      project_id: projectId,
      set_values: values.map((entry) => ({
        key: entry.key,
        value: entry.value,
        is_secret: entry.is_secret,
        type: "envvar",
      })),
      remove: [],
    });
  }

  ctx.log("Deploy");
  const tool =
    currentAccess === "custom" ? "sites.deploy_private_site_version" : "sites.deploy_site_version";
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
    await client.callTool("sites.update_site_access", {
      project_id: projectId,
      access_mode: targetAccess,
    });
    accessMode = targetAccess;
  }

  const nextState: LocalState = {
    ...uploadedState,
    last_deployment_id: deploymentId,
    last_version_id: version.id,
    last_commit_sha: commitSha ?? undefined,
    last_artifact_hash: dist.treeHash,
    updated_at: new Date().toISOString(),
  };
  writeState(ctx.root, nextState);
  ctx.success("Deploy complete");

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
    detection: detectionReport(build.detection, dist.kind),
    environment,
  };
}

function archiveSizeOf(archive: { archiveSize: number }): number {
  return archive.archiveSize;
}

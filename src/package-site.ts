// Artifact validation, manifest staging, and tar creation (plan §5.2).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import type { Manifest } from "./manifest.ts";
import { readManifest } from "./manifest.ts";
import { registerCleanup } from "./util.ts";
import { validateBundleText } from "./bundler.ts";

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type SiteKind = "static" | "worker";

export interface DistInfo {
  kind: SiteKind;
  entry: string;
  fileCount: number;
  sizeBytes: number;
  treeHash: string;
}

export interface ArchiveInfo extends DistInfo {
  archiveFile: string;
  archiveSize: number;
  archiveSha256: string;
}

function walkDist(dist: string): Array<{ relative: string; size: number }> {
  const files: Array<{ relative: string; size: number }> = [];
  const walk = (relative: string): void => {
    const absolute = path.join(dist, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new CliError(
        "PREFLIGHT_UNSUPPORTED_FILE",
        `Symbolic links are not allowed: ${relative}`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Replace the symlink with a regular file.",
        },
      );
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) walk(path.join(relative, entry));
      return;
    }
    if (!stat.isFile()) {
      throw new CliError(
        "PREFLIGHT_UNSUPPORTED_FILE",
        `Special files are not allowed: ${relative}`,
        {
          exitCode: EXIT.PREFLIGHT,
        },
      );
    }
    files.push({ relative: relative.split(path.sep).join("/"), size: stat.size });
  };
  walk("");
  return files;
}

function hashTree(dist: string, files: Array<{ relative: string }>): string {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dist, file.relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateWorkerEntry(file: string, relative: string): void {
  validateBundleText(fs.readFileSync(file, "utf8"), relative);
}

export function inspectDist(root: string, manifest: Manifest): DistInfo {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
    throw new CliError("PREFLIGHT_NO_BUILD_OUTPUT", "dist/ does not exist.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run a build first.",
    });
  }
  const kind: SiteKind = manifest.static ? "static" : "worker";

  if (kind === "static") {
    const unsupported = [
      manifest.d1 ? "d1" : null,
      manifest.r2 ? "r2" : null,
      manifest.capabilities?.length ? "capabilities" : null,
    ].filter(Boolean);
    if (unsupported.length) {
      throw new CliError(
        "PREFLIGHT_STATIC_WITH_BINDINGS",
        `A static site cannot use ${unsupported.join(", ")}.`,
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Remove the binding from hosting.json or convert the site to a Worker.",
          details: { unsupported },
        },
      );
    }
  }

  const files = walkDist(dist);
  const sizeBytes = files.reduce((total, file) => total + file.size, 0);
  if (sizeBytes > MAX_ARCHIVE_BYTES) {
    throw new CliError(
      "PREFLIGHT_ARCHIVE_TOO_LARGE",
      `The artifact is ${sizeBytes} bytes; the limit is ${MAX_ARCHIVE_BYTES} bytes.`,
      {
        exitCode: EXIT.PREFLIGHT,
        hint: "Reduce the artifact below 512 MiB.",
        details: { size_bytes: sizeBytes, limit_bytes: MAX_ARCHIVE_BYTES },
      },
    );
  }

  const entryRelative = kind === "static" ? "index.html" : "server/index.js";
  if (!files.some((file) => file.relative === entryRelative)) {
    throw new CliError("PREFLIGHT_MISSING_ENTRY", `dist/${entryRelative} is missing.`, {
      exitCode: EXIT.PREFLIGHT,
      hint:
        kind === "static"
          ? "Write the static site to dist/index.html."
          : "Write the bundled Worker to dist/server/index.js.",
    });
  }
  if (kind === "worker") {
    validateWorkerEntry(path.join(dist, entryRelative), `dist/${entryRelative}`);
    if (files.some((file) => file.relative === "index.html")) {
      throw new CliError(
        "PREFLIGHT_INVALID_BUNDLE",
        "A Worker site also contains dist/index.html.",
        {
          exitCode: EXIT.PREFLIGHT,
          hint: "Remove static output or declare `static` in hosting.json.",
        },
      );
    }
  }

  return {
    kind,
    entry: `dist/${entryRelative}`,
    fileCount: files.length,
    sizeBytes,
    treeHash: hashTree(dist, files),
  };
}

function stageManifest(root: string, manifest: Manifest): void {
  const target = path.join(root, "dist", ".openai");
  fs.mkdirSync(target, { recursive: true });
  const output: Manifest = { ...manifest };
  if (manifest.static) {
    output.static = { ...manifest.static, directory: "dist" };
  }
  delete output.plugins;
  delete output.connectors;
  fs.writeFileSync(path.join(target, "hosting.json"), JSON.stringify(output, null, 2) + "\n");

  const migrations = path.join(root, "drizzle");
  if (manifest.d1 && fs.existsSync(migrations)) {
    fs.cpSync(migrations, path.join(target, "drizzle"), { recursive: true });
  }
}

async function runTar(root: string, archiveFile: string): Promise<void> {
  const child = spawn("tar", ["-czf", archiveFile, "dist"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) {
    throw new CliError("PACKAGE_FAILED", `tar exited with code ${code}.`, {
      exitCode: EXIT.GENERAL,
      details: { stderr: stderr.trim() },
    });
  }
}

export async function createArchive(root: string): Promise<ArchiveInfo> {
  const manifest = readManifest(root).manifest;
  const before = inspectDist(root, manifest);
  stageManifest(root, manifest);
  const after = inspectDist(root, manifest);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sites-archive-"));
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archiveFile = path.join(dir, "site.tar.gz");
  await runTar(root, archiveFile);
  const stat = fs.statSync(archiveFile);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");
  return {
    ...after,
    treeHash: before.treeHash === after.treeHash ? before.treeHash : after.treeHash,
    archiveFile,
    archiveSize: stat.size,
    archiveSha256: sha256,
  };
}

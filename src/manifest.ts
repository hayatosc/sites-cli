// Project manifest and local state handling (plan §5.2/§6.2).

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";
import type { McpClient } from "./mcp.ts";
import type { ListSitesResult } from "./api-types.ts";

export const MANIFEST_DIR = ".openai";
export const MANIFEST_NAME = "hosting.json";
export const STATE_DIR = ".sites";
export const STATE_NAME = "state.json";

export interface StaticConfig {
  directory: string;
  not_found_handling?: "none" | "404-page" | "single-page-application";
}

export interface Manifest {
  project_id: string | null;
  static?: StaticConfig | null;
  d1?: string | null;
  r2?: string | null;
  capabilities?: string[];
  plugins?: unknown[];
  connectors?: unknown[];
  [key: string]: unknown;
}

export interface LocalState {
  last_deployment_id?: string;
  last_version_id?: string;
  last_commit_sha?: string;
  last_artifact_hash?: string;
  last_uploaded_version_id?: string;
  last_uploaded_commit_sha?: string;
  last_uploaded_artifact_hash?: string;
  tags?: Record<string, string>;
  updated_at?: string;
  [key: string]: unknown;
}

export function manifestPath(root = process.cwd()): string {
  return path.join(root, MANIFEST_DIR, MANIFEST_NAME);
}

export function readManifest(root = process.cwd()): {
  manifest: Manifest;
  raw: string;
  file: string;
} {
  const file = manifestPath(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const relative = path.relative(root, file) || file;
      throw new CliError("PREFLIGHT_NO_MANIFEST", `No Sites manifest found at ${relative}.`, {
        exitCode: EXIT.PREFLIGHT,
        hint: "Run `sites init` or `sites create <slug>` to create one.",
        details: { path: relative },
      });
    }
    throw error;
  }
  try {
    return { manifest: JSON.parse(raw) as Manifest, raw, file };
  } catch {
    throw new CliError(
      "PREFLIGHT_INVALID_MANIFEST",
      `Invalid JSON in ${path.relative(root, file) || file}.`,
      {
        exitCode: EXIT.PREFLIGHT,
        hint: "Fix the JSON syntax and retry.",
      },
    );
  }
}

export function writeManifest(root: string, manifest: Manifest): string {
  const file = manifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

export function readState(root = process.cwd()): LocalState {
  const file = path.join(root, STATE_DIR, STATE_NAME);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LocalState;
  } catch {
    return {};
  }
}

export function writeState(root: string, state: LocalState): string {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STATE_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export function projectIdFromManifest(root: string): string | null {
  try {
    return readManifest(root).manifest.project_id ?? null;
  } catch {
    return null;
  }
}

export async function resolveProjectRef(
  ref: string | undefined,
  client: McpClient,
  root = process.cwd(),
): Promise<string> {
  const candidate = ref || projectIdFromManifest(root);
  if (!candidate) {
    throw new CliError("PREFLIGHT_NO_PROJECT", "No project_id is configured.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run `sites create <slug>` first, or pass a project_id or slug.",
    });
  }
  if (candidate.startsWith("appgprj_")) return candidate;

  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const args: Record<string, unknown> = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await client.callTool<ListSitesResult>("sites.list_sites", args);
    const found = (result.items ?? []).find((site) => site.slug === candidate);
    if (found?.id) return found.id;
    cursor = result.cursor ?? undefined;
    if (!cursor) break;
  }
  throw new CliError("NOT_FOUND", `No site found with slug "${candidate}".`, {
    exitCode: EXIT.PREFLIGHT,
    hint: "Run `sites list` to see your sites.",
  });
}

// Project and build-output detection modeled on cf's autoconfig/build flow.

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.ts";

export type ProjectKind = "static" | "worker";

export interface DetectedFramework {
  id: string;
  name: string;
  buildCommand: string;
  outputDirectory: string;
  kind: ProjectKind;
}

export interface ProjectDetection {
  framework: DetectedFramework | null;
  packageManager: string;
  buildScript: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  kind: ProjectKind;
  warnings: string[];
}

interface FrameworkDefinition extends DetectedFramework {
  configFiles: string[];
  dependencies: string[];
  auxiliary?: boolean;
  priority: number;
}

const FRAMEWORKS: FrameworkDefinition[] = [
  {
    id: "astro",
    name: "Astro",
    configFiles: ["astro.config.mjs", "astro.config.mts", "astro.config.js", "astro.config.ts"],
    dependencies: ["astro"],
    buildCommand: "astro build",
    outputDirectory: "dist",
    kind: "static",
    priority: 100,
  },
  {
    id: "next",
    name: "Next.js",
    configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
    dependencies: ["next"],
    buildCommand: "next build",
    outputDirectory: "out",
    kind: "static",
    priority: 100,
  },
  {
    id: "nuxt",
    name: "Nuxt",
    configFiles: ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"],
    dependencies: ["nuxt"],
    buildCommand: "nuxt build",
    outputDirectory: ".output/public",
    kind: "static",
    priority: 100,
  },
  {
    id: "sveltekit",
    name: "SvelteKit",
    configFiles: ["svelte.config.js", "svelte.config.ts"],
    dependencies: ["@sveltejs/kit"],
    buildCommand: "vite build",
    outputDirectory: "build",
    kind: "static",
    priority: 100,
  },
  {
    id: "gatsby",
    name: "Gatsby",
    configFiles: ["gatsby-config.js", "gatsby-config.ts"],
    dependencies: ["gatsby"],
    buildCommand: "gatsby build",
    outputDirectory: "public",
    kind: "static",
    priority: 100,
  },
  {
    id: "angular",
    name: "Angular",
    configFiles: ["angular.json"],
    dependencies: ["@angular/cli"],
    buildCommand: "ng build",
    outputDirectory: "dist",
    kind: "static",
    priority: 100,
  },
  {
    id: "docusaurus",
    name: "Docusaurus",
    configFiles: ["docusaurus.config.js", "docusaurus.config.ts"],
    dependencies: ["@docusaurus/core"],
    buildCommand: "docusaurus build",
    outputDirectory: "build",
    kind: "static",
    priority: 100,
  },
  {
    id: "remix",
    name: "Remix",
    configFiles: ["remix.config.js", "remix.config.ts"],
    dependencies: ["@remix-run/dev"],
    buildCommand: "remix vite:build",
    outputDirectory: "build/client",
    kind: "static",
    priority: 100,
  },
  {
    id: "react-router",
    name: "React Router",
    configFiles: ["react-router.config.ts", "react-router.config.js"],
    dependencies: ["@react-router/dev"],
    buildCommand: "react-router build",
    outputDirectory: "build/client",
    kind: "static",
    priority: 100,
  },
  {
    id: "qwik",
    name: "Qwik",
    configFiles: ["qwik.config.ts", "qwik.config.js"],
    dependencies: ["@builder.io/qwik"],
    buildCommand: "qwik build",
    outputDirectory: "dist",
    kind: "static",
    priority: 100,
  },
  {
    id: "analog",
    name: "Analog",
    configFiles: [],
    dependencies: ["@analogjs/platform"],
    buildCommand: "ng build",
    outputDirectory: "dist/analog/public",
    kind: "static",
    priority: 100,
  },
  {
    id: "hugo",
    name: "Hugo",
    configFiles: ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml"],
    dependencies: [],
    buildCommand: "hugo",
    outputDirectory: "public",
    kind: "static",
    priority: 100,
  },
  {
    id: "vite",
    name: "Vite",
    configFiles: [
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.cjs",
      "vite.config.ts",
      "vite.config.mts",
      "vite.config.cts",
    ],
    dependencies: ["vite"],
    buildCommand: "vite build",
    outputDirectory: "dist",
    kind: "static",
    auxiliary: true,
    priority: 10,
  },
];

const LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "aube-lock.yaml", manager: "aube" },
  { file: "package-lock.json", manager: "npm" },
];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  [key: string]: unknown;
}

export function readPackageJson(root: string): PackageJson | null {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
  } catch {
    throw new CliError("PREFLIGHT_INVALID_PACKAGE", "package.json is not valid JSON.", {
      exitCode: EXIT.PREFLIGHT,
    });
  }
}

export function detectPackageManager(root: string, pkg: PackageJson | null): string {
  const declared = pkg?.packageManager;
  if (typeof declared === "string" && declared.length > 0) {
    return declared.split("@")[0];
  }
  for (const entry of LOCKFILES) {
    if (fs.existsSync(path.join(root, entry.file))) return entry.manager;
  }
  return "npm";
}

function matchesFramework(root: string, pkg: PackageJson | null, definition: FrameworkDefinition) {
  if (definition.configFiles.some((file) => fs.existsSync(path.join(root, file)))) return true;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return definition.dependencies.some((dependency) => dependency in deps);
}

function selectFramework(root: string, pkg: PackageJson | null): DetectedFramework | null {
  const matches = FRAMEWORKS.filter((definition) => matchesFramework(root, pkg, definition));
  const primary = matches.filter((definition) => !definition.auxiliary);
  const candidates = primary.length > 0 ? primary : matches;
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => right.priority - left.priority);
  if (
    candidates.length > 1 &&
    candidates[0].priority === candidates[1].priority &&
    candidates[0].id !== candidates[1].id
  ) {
    throw new CliError(
      "PREFLIGHT_MULTIPLE_FRAMEWORKS",
      `Multiple frameworks detected: ${candidates.map((entry) => entry.name).join(", ")}.`,
      {
        exitCode: EXIT.PREFLIGHT,
        hint: "Remove the conflicting framework configuration or build the project before deploying.",
        details: { frameworks: candidates.map((entry) => entry.id) },
      },
    );
  }
  const selected = candidates[0];
  return {
    id: selected.id,
    name: selected.name,
    buildCommand: selected.buildCommand,
    outputDirectory: selected.outputDirectory,
    kind: selected.kind,
  };
}

function buildScriptFor(
  pkg: PackageJson | null,
  framework: DetectedFramework | null,
): string | null {
  const scripts = pkg?.scripts ?? {};
  if (framework) {
    const preferred = Object.entries(scripts)
      .filter(([, value]) => value.includes(framework.buildCommand))
      .map(([name]) => name)
      .sort((left, right) => {
        const rank = (name: string) => (name === "build" ? 0 : name.endsWith(":build") ? 1 : 2);
        return rank(left) - rank(right);
      });
    if (preferred.length > 0) return preferred[0];
  }
  if (typeof scripts.build === "string") return "build";
  if (framework) {
    const names = Object.keys(scripts).filter((name) => name.startsWith("build:"));
    if (names.length > 0) return names[0];
  }
  return null;
}

function hasIndex(directory: string): boolean {
  return fs.existsSync(path.join(directory, "index.html"));
}

export function findStaticDirectory(root: string): string | null {
  const candidates = [
    root,
    "public",
    "dist",
    "build",
    "out",
    "_site",
    "site",
    "dist/client",
    "build/client",
    ".output/public",
  ];
  for (const candidate of candidates) {
    const directory = path.resolve(root, candidate);
    if (hasIndex(directory)) return directory;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if ([".git", "node_modules", ".sites", ".openai"].includes(entry.name)) continue;
    const directory = path.join(root, entry.name);
    if (hasIndex(directory)) return directory;
  }
  return null;
}

function angularOutputDirectory(root: string): string | null {
  const file = path.join(root, "angular.json");
  if (!fs.existsSync(file)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
      defaultProject?: string;
      projects?: Record<string, { architect?: { build?: { options?: { outputPath?: string } } } }>;
    };
    const project =
      config.projects?.[config.defaultProject ?? Object.keys(config.projects ?? {})[0]];
    const outputPath = project?.architect?.build?.options?.outputPath;
    if (!outputPath) return null;
    return outputPath.endsWith("/browser") ? outputPath : path.join(outputPath, "browser");
  } catch {
    return null;
  }
}

function nextStaticExport(root: string): boolean {
  for (const file of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    return /output\s*:\s*["']export["']/.test(fs.readFileSync(absolute, "utf8"));
  }
  return false;
}

export function detectProject(root: string): ProjectDetection {
  const pkg = readPackageJson(root);
  const packageManager = detectPackageManager(root, pkg);
  const framework = selectFramework(root, pkg);
  const buildScript = buildScriptFor(pkg, framework);
  const warnings: string[] = [];

  if (framework?.id === "next" && !nextStaticExport(root)) {
    warnings.push(
      'Next.js without `output: "export"` does not produce a static directory; deploy an exported build or a Worker bundle.',
    );
  }
  if (pkg && !fs.existsSync(path.join(root, "package-lock.json")) && packageManager === "npm") {
    warnings.push("No lockfile found; dependency versions may not be reproducible.");
  }

  let outputDirectory: string | null = framework?.outputDirectory ?? null;
  if (framework?.id === "angular") {
    outputDirectory = angularOutputDirectory(root) ?? outputDirectory;
  }

  return {
    framework,
    packageManager,
    buildScript,
    buildCommand: framework?.buildCommand ?? null,
    outputDirectory,
    kind: framework?.kind ?? "static",
    warnings,
  };
}

export interface BuildOutputPaths {
  staticDirectory: string | null;
  workerEntry: string | null;
}

export function findBuildOutput(root: string, detection: ProjectDetection): BuildOutputPaths {
  const preferred = detection.outputDirectory
    ? path.resolve(root, detection.outputDirectory)
    : null;
  const staticDirectory =
    preferred && hasIndex(preferred)
      ? preferred
      : detection.outputDirectory
        ? null
        : findStaticDirectory(root);

  const workerCandidates = [
    "dist/server/index.js",
    "dist/server/index.mjs",
    ".output/server/index.mjs",
    ".output/server/index.js",
    "build/server/index.js",
    ".svelte-kit/cloudflare/_worker.js",
    "dist/_worker.js",
  ];
  let workerEntry: string | null = null;
  for (const candidate of workerCandidates) {
    const absolute = path.resolve(root, candidate);
    if (fs.existsSync(absolute)) {
      workerEntry = absolute;
      break;
    }
  }
  return { staticDirectory, workerEntry };
}

export function packageCommand(manager: string, command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const args = parts.map((part) => part.replace(/^["']|["']$/g, ""));
  switch (manager) {
    case "pnpm":
      return ["pnpm", "exec", ...args];
    case "yarn":
      return ["yarn", ...args];
    case "bun":
      return ["bunx", ...args];
    case "aube":
      return ["aube", "exec", ...args];
    default:
      return ["npx", ...args];
  }
}

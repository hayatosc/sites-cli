// Deployment builds retain native subprocess semantics without standalone project tooling.

import { beforeAll, afterAll, test } from "vite-plus/test";
import { build } from "rolldown";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeManifest } from "../src/manifest.ts";
import { forwardSignal } from "../src/util.ts";
import { runCli, tempDir } from "./helpers/index.ts";

function offline(root: string) {
  return {
    SITES_ACCESS_TOKEN: undefined,
    SITES_AUTH_PATH: path.join(root, "missing-auth.json"),
    SITES_MCP_URL: "http://127.0.0.1:1/mcp",
  };
}

function manifest(root: string) {
  writeManifest(root, { project_id: "appgprj_fixture", static: { directory: "dist" } });
}

for (const flag of ["--temporary-account", "--event-code=fixture-shared-event-secret"])
  test(`${flag.split("=")[0]} is explicitly unsupported without leaking values or accessing credentials`, async () => {
    const root = tempDir();
    const result = await runCli(["auth", "whoami", flag], { cwd: root, env: offline(root) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not supported/);
    assert.doesNotMatch(result.stderr, /fixture-shared-event-secret/);
    assert.deepEqual(fs.readdirSync(root), []);
  });

test("doctor remains a read-only diagnostic without Git initialization", async () => {
  const root = tempDir();
  const result = await runCli(["doctor", "--offline"], { cwd: root, env: offline(root) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).checks.length, 12);
  assert.deepEqual(fs.readdirSync(root), []);
});

const bundleDir = tempDir("sites-signal-cli-");
const cli = path.join(bundleDir, "cli.mjs");
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // Build the real entry point. Only documentation data is stubbed; the tests
  // exercise OS signals and cannot use Vite's in-process virtual module loader.
  await build({
    input: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    platform: "node",
    plugins: [
      {
        name: "signal-test-cli",
        resolveId(id) {
          if (id === "virtual:sites-docs") return "\0test-docs";
          if (id === "rolldown") return { id: require.resolve(id), external: true };
        },
        load(id) {
          if (id === "\0test-docs") return "export const bundledDocs = [];";
        },
      },
    ],
    output: { file: cli, format: "esm" },
  });
});
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const handledCode of [0, 7, null]) {
    const graceful = handledCode !== null;
    test.skipIf(process.platform === "win32")(
      `deploy build forwards ${signal}, waits for close, preserves ${graceful ? `graceful exit ${handledCode}` : "signal status"}`,
      async () => {
        const root = tempDir();
        const bin = path.join(root, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ scripts: { build: "fixture" } }),
        );
        manifest(root);
        const marker = path.join(root, "closed");
        fs.writeFileSync(
          path.join(bin, "npm"),
          `#!${process.execPath}\nconst fs = require('node:fs');\n${graceful ? `process.on(${JSON.stringify(signal)}, () => { console.log('received:${signal}'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'closed'); console.log('shutdown-complete'); process.exit(${handledCode}); }, 150); });` : ""}\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n`,
          { mode: 0o755 },
        );
        const child = spawn(process.execPath, [cli, "deploy", "--dry-run"], {
          cwd: root,
          env: {
            ...process.env,
            ...offline(root),
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        const ready = new Promise<void>((resolve) => {
          const check = () => {
            if ((stdout + stderr).includes("ready")) resolve();
          };
          child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
            check();
          });
          child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
            check();
          });
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
          await Promise.race([
            ready,
            closed.then(() => {
              throw new Error(`CLI exited before readiness: ${stderr}`);
            }),
          ]);
          child.kill(signal);
          const result = await closed;
          assert.equal(result.signal, null, stderr);
          assert.equal(result.code, 130, stderr);
          if (graceful) {
            assert.match(stdout + stderr, new RegExp(`received:${signal}`));
            assert.match(stdout + stderr, /shutdown-complete/);
            assert.equal(fs.readFileSync(marker, "utf8"), "closed");
          }
          assert.equal(stdout, "");
        } finally {
          clearTimeout(timer);
          child.kill("SIGKILL");
        }
      },
    );
  }
}

for (const quiet of [false, true]) {
  test.skipIf(process.platform !== "linux" || !fs.existsSync("/usr/bin/script"))(
    `deploy build ${quiet ? "quiet output" : "native stdio"} keeps real PTY semantics`,
    () => {
      const root = tempDir();
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      manifest(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { build: "fixture" } }),
      );
      fs.writeFileSync(
        path.join(bin, "npm"),
        `#!${process.execPath}\nconst fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','fixture'); const tty={stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,stderr:!!process.stderr.isTTY}; fs.writeFileSync('tty.json',JSON.stringify(tty)); console.log('TTY:'+JSON.stringify(tty)); console.error('terminal-stderr');\n`,
        { mode: 0o755 },
      );
      const command = [process.execPath, cli, "deploy", "--dry-run", ...(quiet ? ["--quiet"] : [])]
        .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
        .join(" ");
      const result = spawnSync("/usr/bin/script", ["-qec", command, "/dev/null"], {
        cwd: root,
        env: {
          ...process.env,
          ...offline(root),
          SHELL: "/bin/sh",
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "tty.json"), "utf8")), {
        stdin: true,
        stdout: !quiet,
        stderr: !quiet,
      });
      if (quiet) assert.equal(result.stdout + result.stderr, "");
      else {
        assert.match(result.stdout, /TTY:/);
        assert.match(result.stdout, /terminal-stderr/);
      }
    },
  );
}

test("deploy normalizes build failure to exit 1 with progress only on stderr", async () => {
  const root = tempDir();
  manifest(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "node fail.cjs" } }),
  );
  fs.writeFileSync(
    path.join(root, "fail.cjs"),
    "console.log('build-progress'); console.error('build-error'); process.exitCode=7;",
  );
  const result = await runCli(["deploy", "--dry-run"], { cwd: root, env: offline(root) });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /build-progress/);
  assert.match(result.stderr, /build-error/);
  assert.match(result.stderr, /Error:/);
});

test("completed embedded deploy build releases its signal handler", async () => {
  const root = tempDir();
  manifest(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "node build.cjs" } }),
  );
  fs.writeFileSync(
    path.join(root, "build.cjs"),
    "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html','fixture');",
  );
  const result = await runCli(["deploy", "--dry-run"], { cwd: root, env: offline(root) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(forwardSignal("SIGTERM"), false);
});

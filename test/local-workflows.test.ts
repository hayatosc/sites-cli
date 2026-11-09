// Local-only cf counterparts and real subprocess interruption; never use live services.

import { beforeAll, afterAll, test, vi } from "vite-plus/test";
import readline from "node:readline";
import { PassThrough } from "node:stream";
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

test("migrations create defaults to deployable drizzle SQL without credentials or a database", async () => {
  const root = tempDir();
  const first = await runCli(["migrations", "create", "initial schema"], {
    cwd: root,
    env: offline(root),
    defaultOutput: true,
  });
  assert.equal(first.code, 0, first.stderr);
  const data = JSON.parse(first.stdout);
  assert.equal(data.name, "0001_initial_schema.sql");
  assert.equal(data.path, path.join(root, "drizzle", data.name));
  assert.match(fs.readFileSync(data.path, "utf8"), /^-- Migration number: 0001\s+\d{4}-/);
  const second = await runCli(["migrations", "create", "add column", "--human"], {
    cwd: root,
    env: offline(root),
  });
  assert.equal(second.code, 0, second.stderr);
  assert.ok(fs.existsSync(path.join(root, "drizzle/0002_add_column.sql")));
  assert.deepEqual(fs.readdirSync(root), ["drizzle"]);
});

test("migration numbering only considers the matching pattern, numerically rather than lexicographically", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "sql/0050_nested"), { recursive: true });
  for (const file of [
    "9_old.sql",
    "0010_new.sql",
    "seed.sql",
    ".999_hidden.sql",
    "0050_nested/migration.sql",
  ])
    fs.writeFileSync(path.join(root, "sql", file), "-- retained\n");
  const result = await runCli(
    ["migrations", "create", "next", "--dir", "./sql/", "--pattern", "sql/*.sql"],
    { cwd: root, env: offline(root) },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).name, "0011_next.sql");
  assert.equal(fs.readFileSync(path.join(root, "sql/0010_new.sql"), "utf8"), "-- retained\n");
});

test("migration glob matching and quiet work without Node 22's experimental matchesGlob", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "sql"));
  for (const file of ["0012_old.sql", "0099_ignore.txt", "schema.sql"])
    fs.writeFileSync(path.join(root, "sql", file), "-- retained\n");
  const builtin = vi.spyOn(path.posix, "matchesGlob").mockImplementation(() => {
    throw new Error("Experimental Node 22 API must not be used");
  });
  try {
    const args = ["migrations", "create", "next", "--dir", "sql", "--pattern", "sql/????_*.sql"];
    const result = await runCli(args, { cwd: root, env: offline(root) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, "0013_next.sql");
    const quiet = await runCli([...args, "--quiet"], { cwd: root, env: offline(root) });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout + quiet.stderr, "");
    assert.ok(fs.existsSync(path.join(root, "sql/0014_next.sql")));
    assert.equal(builtin.mock.calls.length, 0);
  } finally {
    builtin.mockRestore();
  }
});

for (const name of ["../escape", "nested\\escape", "bad:stream", "bad?file", "", "bad\nfile"])
  test(`migration name ${JSON.stringify(name)} is rejected before creating directories`, async () => {
    const root = tempDir();
    const result = await runCli(["migrations", "create", name], { cwd: root, env: offline(root) });
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(fs.readdirSync(root), []);
  });

for (const flags of [
  ["--pattern", "drizzle/*.sql"],
  ["--dir", "sql", "--pattern", "outside/*.sql"],
  ["--dir", "sql", "--pattern", "sql/*/migration.sql"],
  ...[
    "sql/{[0-9]*,schema}.sql",
    "sql/[0-9]*.sql",
    "sql/**.sql",
    "sql/!(seed).sql",
    "sql/+(old).sql",
    "sql/@(old).sql",
    "sql/*.txt",
    "sql/**/../*.sql",
  ].map((pattern) => ["--dir", "sql", "--pattern", pattern]),
])
  test(`migration pattern ${flags.join(" ")} refuses an unpicked file without writes`, async () => {
    const root = tempDir();
    const result = await runCli(["migrations", "create", "next", ...flags], {
      cwd: root,
      env: offline(root),
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /^Error: /);
    assert.deepEqual(fs.readdirSync(root), []);
  });

test("migration limited wildcards handle retries, literals, Unicode and ignore symlinks", async () => {
  for (const pattern of ["sql/*.sql", "sql/*_ne?t.sql", "sql/*e*t.sql", "sql/????_*.sql"]) {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "sql"));
    fs.writeFileSync(path.join(root, "sql/0010_next.sql"), "-- retained");
    if (process.platform !== "win32") {
      fs.writeFileSync(path.join(root, "9999_next.sql"), "-- outside");
      fs.symlinkSync(path.join(root, "9999_next.sql"), path.join(root, "sql/9999_next.sql"));
    }
    const result = await runCli(
      ["migrations", "create", "next", "--dir", "sql", "--pattern", pattern],
      { cwd: root, env: offline(root) },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, "0011_next.sql");
  }
  const root = tempDir();
  const result = await runCli(
    ["migrations", "create", "😀", "--dir", "sql", "--pattern", "sql/????_?.sql"],
    { cwd: root, env: offline(root) },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).name, "0001_😀.sql");
});

test("migration dry-run is argument-only, secret-safe and quiet; local types are generated offline", async () => {
  const root = tempDir();
  const dry = await runCli(["migrations", "create", "private-value", "--dry-run"], {
    cwd: root,
    env: offline(root),
    defaultOutput: true,
  });
  assert.equal(dry.code, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /private-value/);
  assert.deepEqual(fs.readdirSync(root), []);
  const quiet = await runCli(["migrations", "create", "initial", "--quiet"], {
    cwd: root,
    env: offline(root),
  });
  assert.equal(quiet.stdout + quiet.stderr, "");
  writeManifest(root, { project_id: null, d1: "DB", r2: 'quoted"bucket' });
  const result = await runCli(["types"], { cwd: root, env: offline(root) });
  assert.equal(result.code, 0, result.stderr);
  const file = path.join(root, ".openai/types.d.ts");
  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /"DB": D1Database;/);
  assert.match(content, /"quoted\\"bucket": R2Bucket;/);
  assert.doesNotMatch(content, /project_id|private-value/);
  const modified = fs.statSync(file).mtimeMs;
  assert.equal((await runCli(["types"], { cwd: root, env: offline(root) })).code, 0);
  assert.equal(fs.statSync(file).mtimeMs, modified);
});

test("types rejects unsupported runtime generation, duplicate bindings and manual-file replacement", async () => {
  const root = tempDir();
  writeManifest(root, { project_id: null, d1: "DB", r2: "DB" });
  assert.equal((await runCli(["types"], { cwd: root, env: offline(root) })).code, 1);
  writeManifest(root, { project_id: null, d1: "DB" });
  assert.equal(
    (await runCli(["types", "--include-runtime"], { cwd: root, env: offline(root) })).code,
    1,
  );
  fs.writeFileSync(path.join(root, ".openai/types.d.ts"), "// handwritten\n");
  const denied = await runCli(["types"], { cwd: root, env: offline(root) });
  assert.equal(denied.code, 1, denied.stderr);
  assert.equal(fs.readFileSync(path.join(root, ".openai/types.d.ts"), "utf8"), "// handwritten\n");
  assert.equal(
    (
      await runCli(["types", "--out", "env.d.ts", "--include-runtime=false"], {
        cwd: root,
        env: offline(root),
      })
    ).code,
    0,
  );
  assert.equal((await runCli(["types", "--force"], { cwd: root, env: offline(root) })).code, 0);
});

for (const flag of ["--temporary-account", "--event-code=fixture-shared-event-secret"])
  test(`${flag.split("=")[0]} is explicitly unsupported without leaking values or accessing credentials`, async () => {
    const root = tempDir();
    const result = await runCli(["auth", "whoami", flag], { cwd: root, env: offline(root) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not supported/);
    assert.doesNotMatch(result.stderr, /fixture-shared-event-secret/);
    assert.deepEqual(fs.readdirSync(root), []);
  });

for (const answer of ["", "no"]) {
  test(`migration directory prompt ${answer ? "declines without writes" : "defaults to yes"}`, async () => {
    const root = tempDir();
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const createInterface = readline.createInterface;
    const prompt = vi.spyOn(readline, "createInterface").mockImplementation(() => {
      const input = new PassThrough();
      const rl = createInterface({ input, output: new PassThrough(), terminal: false });
      setImmediate(() => input.end(`${answer}\n`));
      return rl;
    });
    try {
      const result = await runCli(["migrations", "create", "initial"], {
        cwd: root,
        env: offline(root),
      });
      assert.equal(result.code, answer ? 130 : 0, result.stderr);
      assert.equal(fs.existsSync(path.join(root, "drizzle")), !answer);
    } finally {
      prompt.mockRestore();
      if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
}

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
for (const verb of ["dev", "build"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const handledCode of [0, 7, null]) {
      const graceful = handledCode !== null;
      test.skipIf(process.platform === "win32")(
        `${verb} forwards ${signal}, waits for close, preserves ${graceful ? `graceful exit ${handledCode}` : "signal status"}`,
        async () => {
          const root = tempDir();
          const bin = path.join(root, "bin");
          fs.mkdirSync(bin);
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({ scripts: { dev: "fixture", build: "fixture" } }),
          );
          writeManifest(root, { project_id: null, static: { directory: "../dist" } });
          const marker = path.join(root, "closed");
          fs.writeFileSync(
            path.join(bin, "npm"),
            `#!${process.execPath}\nconst fs = require('node:fs');\n${graceful ? `process.on(${JSON.stringify(signal)}, () => { console.log('received:${signal}'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'closed'); console.log('shutdown-complete'); process.exit(${handledCode}); }, 150); });` : ""}\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n`,
            { mode: 0o755 },
          );
          const child = spawn(process.execPath, [cli, verb], {
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
            assert.doesNotMatch(stdout, /"ok"|"exit_code"/);
            if (verb === "build") assert.equal(stdout, "");
          } finally {
            clearTimeout(timer);
            child.kill("SIGKILL");
          }
        },
      );
    }
  }
}

for (const verb of ["dev", "build"]) {
  for (const quiet of [false, true]) {
    test.skipIf(process.platform !== "linux" || !fs.existsSync("/usr/bin/script"))(
      `${verb} ${quiet ? "quiet output" : "native stdio"} keeps real PTY semantics`,
      () => {
        const root = tempDir();
        const bin = path.join(root, "bin");
        fs.mkdirSync(bin);
        writeManifest(root, { project_id: null, static: { directory: "../dist" } });
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ scripts: { dev: "fixture", build: "fixture" } }),
        );
        fs.writeFileSync(
          path.join(bin, "npm"),
          `#!${process.execPath}\nconst fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','fixture'); const tty={stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,stderr:!!process.stderr.isTTY}; fs.writeFileSync('tty.json',JSON.stringify(tty)); console.log('TTY:'+JSON.stringify(tty)); console.error('terminal-stderr');\n`,
          { mode: 0o755 },
        );
        const command = [process.execPath, cli, verb, ...(quiet ? ["--quiet"] : [])]
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
}

test("build normalizes child failure to exit 1 with progress only on stderr", async () => {
  const root = tempDir();
  writeManifest(root, { project_id: null, static: { directory: "../dist" } });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "node fail.cjs" } }),
  );
  fs.writeFileSync(
    path.join(root, "fail.cjs"),
    "console.log('build-progress'); console.error('build-error'); process.exitCode=7;",
  );
  for (const defaultOutput of [false, true]) {
    const result = await runCli(["build"], { cwd: root, env: offline(root), defaultOutput });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /build-progress/);
    assert.match(result.stderr, /build-error/);
    assert.match(result.stderr, /Error:/);
  }
});

test("completed embedded dev releases its signal handler", async () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: `${process.execPath} -e "process.exit(0)"` } }),
  );
  const result = await runCli(["dev"], { cwd: root, env: offline(root) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(forwardSignal("SIGTERM"), false);
});

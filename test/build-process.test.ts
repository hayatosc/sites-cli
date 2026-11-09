// Real build subprocesses; no project credentials or remote services.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runBuildProcess } from "../src/build.ts";
import { CliError } from "../src/errors.ts";
import { forwardSignal } from "../src/util.ts";
import { tempDir } from "./helpers/index.ts";

function fixture(source: string) {
  const cwd = tempDir();
  const file = path.join(cwd, "build.cjs");
  fs.writeFileSync(file, source);
  return { file: process.execPath, args: [file], cwd, env: {}, label: "fixture build" };
}

test("build relays both streams before completion and preserves Unicode/partial chunks", async () => {
  let output = "";
  let observed = false;
  const script = fixture(`
const fs = require('node:fs');
process.stdout.write('first✓');
process.stderr.write('second✓');
const poll = setInterval(() => { if (fs.existsSync('ack')) { clearInterval(poll); process.stdout.write('last✓'); } }, 10);
`);
  await runBuildProcess({
    ...script,
    timeoutMs: 3000,
    output: {
      write(chunk) {
        output += chunk;
        if (output.includes("first✓") && output.includes("second✓")) {
          observed = true;
          fs.writeFileSync(path.join(script.cwd, "ack"), "ready");
        }
      },
    },
  });
  assert.equal(observed, true);
  for (const text of ["first✓", "second✓", "last✓"]) assert.ok(output.includes(text));
  assert.equal(forwardSignal("SIGTERM"), false);
});

test("build failure keeps a bounded diagnostic tail and the child's nonzero status", async () => {
  const script = fixture(
    "process.stdout.write('x'.repeat(200000)); console.error('last-line'); process.exitCode=7;",
  );
  await assert.rejects(runBuildProcess({ ...script, output: { write() {} } }), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "BUILD_FAILED");
    assert.equal(error.exitCode, 7);
    const details = error.details as { output: string };
    assert.ok(details.output.length <= 64 * 1024);
    assert.match(details.output, /last-line/);
    return true;
  });
});

test("quiet builds do not relay stdout or stderr", async () => {
  let output = "";
  await runBuildProcess({
    ...fixture("console.log('stdout'); console.error('stderr');"),
    quiet: true,
    output: {
      write(chunk) {
        output += chunk;
      },
    },
  });
  assert.equal(output, "");
});

for (const ignore of [false, true])
  test.skipIf(process.platform === "win32")(
    `build deadline ${ignore ? "escalates an ignored SIGTERM" : "waits for graceful SIGTERM shutdown"}`,
    async () => {
      const script = fixture(`
const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync('terminated', 'yes'); ${ignore ? "" : "setTimeout(() => { fs.writeFileSync('closed', 'yes'); process.exit(0); }, 30);"} });
console.log('ready'); setInterval(() => {}, 1000);
`);
      await assert.rejects(
        runBuildProcess({ ...script, timeoutMs: 1000, killGraceMs: 100, output: { write() {} } }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "BUILD_TIMEOUT");
          assert.equal((error.details as { timeout_ms: number }).timeout_ms, 1000);
          return true;
        },
      );
      assert.equal(fs.readFileSync(path.join(script.cwd, "terminated"), "utf8"), "yes");
      assert.equal(fs.existsSync(path.join(script.cwd, "closed")), !ignore);
      assert.equal(forwardSignal("SIGTERM"), false);
    },
  );

test("failed subprocess startup removes timers and signal forwarding", async () => {
  const cwd = tempDir();
  await assert.rejects(
    runBuildProcess({
      file: path.join(cwd, "missing"),
      args: [],
      cwd,
      env: {},
      label: "missing build",
      output: { write() {} },
    }),
    /ENOENT/,
  );
  assert.equal(forwardSignal("SIGTERM"), false);
});

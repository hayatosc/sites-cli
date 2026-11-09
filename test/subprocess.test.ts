// Windows command construction is checked without launching cmd.exe on the host.
// Native argv round-trips are also run on the current OS.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { spawnCommand } from "../src/subprocess.ts";
import { runCli, tempDir } from "./helpers/index.ts";

const values = [
  "two words",
  'say "hello"',
  "trailing\\",
  "&",
  "|",
  "<>",
  "%PATH%",
  "!EXPAND!",
  "^",
  "",
];
const encoded = [
  String.raw`^"two^ words^"`,
  String.raw`^"say^ \^"hello\^"^"`,
  String.raw`^"trailing\\^"`,
  String.raw`^"^&^"`,
  String.raw`^"^|^"`,
  String.raw`^"^<^>^"`,
  String.raw`^"^%PATH^%^"`,
  String.raw`^"^!EXPAND^!^"`,
  String.raw`^"^^^"`,
  String.raw`^"^"`,
];

async function capture(child: ReturnType<typeof spawn>) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}

test("native execution preserves spaces, quotes, backslashes, metacharacters and empty argv", async () => {
  const root = tempDir();
  const script = path.join(root, "argv.cjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const result = await capture(
    spawnCommand(process.execPath, [script, ...values], {
      cwd: root,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.deepEqual(result, values);
});

test("tinyexec preserves an explicit environment and PATH without adding local bins", async () => {
  const root = tempDir();
  const previous = process.env.SITES_CHILD_ENV_SENTINEL;
  process.env.SITES_CHILD_ENV_SENTINEL = "must-not-leak";
  try {
    const script = path.join(root, "env.cjs");
    fs.writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({ path: process.env.PATH, sentinel: process.env.SITES_CHILD_ENV_SENTINEL, explicit: process.env.EXPLICIT }));",
    );
    const env = await capture(
      spawnCommand(process.execPath, [script], {
        cwd: root,
        env: { PATH: root, EXPLICIT: "retained" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.deepEqual(env, { path: root, explicit: "retained" });
  } finally {
    if (previous === undefined) delete process.env.SITES_CHILD_ENV_SENTINEL;
    else process.env.SITES_CHILD_ENV_SENTINEL = previous;
  }
});

for (const command of ["npm.cmd", "node_modules/.bin/npm.cmd", "tool.exe"]) {
  test(`Windows launch planning for ${command} never uses Node's shell concatenation`, async () => {
    const root = tempDir();
    const file = path.join(root, command);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture only; never executed\n");
    const driver = path.join(root, "driver.cjs");
    // A fresh interpreter loads tinyexec after selecting win32. Intercept the
    // native spawn boundary: only argv construction runs, never any shell code.
    fs.writeFileSync(
      driver,
      `
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
Object.defineProperty(process, 'platform', { value: 'win32' });
process.env.PATHEXT = '.CMD;.EXE'; process.env.comspec = 'cmd.exe';
cp.spawn = (command, args, options) => { process.stdout.write(JSON.stringify({ command, args, shell: options.shell, verbatim: options.windowsVerbatimArguments })); return new EventEmitter(); };
(async () => { const { spawnCommand } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/subprocess.ts")).href)}); spawnCommand(${JSON.stringify(file)}, ${JSON.stringify(values)}, { cwd: ${JSON.stringify(root)}, env: { PATH: ${JSON.stringify(root)}, PATHEXT: '.CMD;.EXE' }, shell: true, windowsVerbatimArguments: true }); })().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    );
    const result = await capture(
      spawn(process.execPath, ["--experimental-strip-types", driver], {
        cwd: root,
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(result.shell, false);
    if (command.endsWith(".exe")) {
      assert.equal(result.command, file);
      assert.equal(result.verbatim, false);
      assert.deepEqual(result.args, values);
    } else {
      assert.equal(result.command, "cmd.exe");
      assert.equal(result.verbatim, true);
      assert.deepEqual(result.args.slice(0, 3), ["/d", "/s", "/c"]);
      const words = command.includes(".bin")
        ? encoded.map((word) => word.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1"))
        : encoded;
      assert.ok(result.args[3].endsWith(` ${words.join(" ")}"`), result.args[3]);
    }
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      command.includes(".bin") ? ["driver.cjs", "node_modules"] : ["driver.cjs", command],
    );
  });
}

for (const binDir of ["bin", "node_modules/.bin"]) {
  test(`dev forwards literal argv through ${binDir} package-manager shim on the current OS`, async () => {
    const root = tempDir();
    const bin = path.join(root, binDir);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "fixture" } }),
    );
    const script = path.join(root, "argv.cjs");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(
      path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm"),
      process.platform === "win32"
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
      { mode: 0o755 },
    );
    const args = [...values, "& echo fixture > injected.txt", "$(touch injected.txt)"];
    const result = await runCli(["dev", "--", ...args], {
      cwd: root,
      defaultOutput: true,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PATHEXT: process.platform === "win32" ? ".CMD;.EXE" : undefined,
        SITES_ACCESS_TOKEN: undefined,
        SITES_AUTH_PATH: path.join(root, "missing-auth.json"),
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["run", "dev", "--", ...args]);
    assert.doesNotMatch(result.stderr, /two words|EXPAND|echo fixture/);
    assert.equal(fs.existsSync(path.join(root, "injected.txt")), false);
  });
}

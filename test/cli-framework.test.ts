import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vite-plus/test";
import * as argumentSupport from "../src/args.ts";
import { createCommands } from "../src/commands/index.ts";
import { createMockMcp, runCli, tempDir } from "./helpers/index.ts";

const offline = {
  SITES_ACCESS_TOKEN: undefined,
  SITES_AUTH_PATH: path.join(tempDir(), "missing-auth.json"),
};

test("all 41 native definitions support --help, -h and the help command offline", async () => {
  const commands = createCommands();
  assert.equal(commands.length, 41);
  assert.equal(commands.filter((command) => !command.hidden).length, 39);
  assert.equal("parseCli" in argumentSupport, false);
  for (const command of commands) {
    assert.ok(command.gunshi, command.path.join(" "));
    for (const flag of command.flags ?? []) assert.ok(command.gunshi.args?.[flag], flag);
    for (const argv of [
      [...command.path, "--help"],
      [...command.path, "-h"],
      ["help", ...command.path],
    ]) {
      const result = await runCli(argv, { env: offline });
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /USAGE:/);
      assert.equal(result.stderr, "");
    }
  }
});

test("Gunshi receives equivalent global booleans before, within and after command paths", async () => {
  for (const flags of [
    ["--quiet", "false"],
    ["--quiet=false"],
    ["-q", "false"],
    ["--no-quiet"],
    ["--human", "false"],
    ["--help", "false"],
    ["--help=false"],
    ["--help", "--help=false"],
    ["--no-help"],
    ["-h", "false"],
    ["--version", "false"],
    ["--version", "--version=false"],
    ["--no-version"],
  ]) {
    for (const argv of [
      [...flags, "cli", "search", "deploy"],
      ["cli", ...flags, "search", "deploy"],
      ["cli", "search", "deploy", ...flags],
    ]) {
      const result = await runCli(argv, { env: offline });
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.stderr}`);
      assert.ok(
        JSON.parse(result.stdout).some(
          (hit: { command: string }) => hit.command === "sites deploy",
        ),
      );
    }
  }
});

test("native validation is strict and never produces the removed JSON error mode", async () => {
  for (const argv of [
    ["list", "--json"],
    ["list", "--json=false", "--limit"],
    ["delete", "--yes"],
    ["delete", "-y"],
    ["list", "--limit", "--quiet"],
    ["list", "--limit=1", "--limit=2"],
    ["list", "extra", "argument"],
    ["env", "set"],
    ["cli", "search", "--quiet=invalid", "deploy"],
    ["list", "--event-code=secret-do-not-print"],
  ]) {
    const result = await runCli(argv, { env: offline });
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error:/);
    assert.doesNotMatch(result.stderr, /\{"ok"|secret-do-not-print/);
  }
});

test("literal tails preserve ordering, empty arguments and flag-looking positional values", async () => {
  const query = await runCli(["cli", "search", "--", "--help"], { env: offline });
  assert.equal(query.code, 0, query.stderr);
  assert.ok(Array.isArray(JSON.parse(query.stdout)));
  const empty = await runCli(["cli", "search", "--", ""]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /empty/);
  const schema = await runCli(["schema", "--", "deploy", "extra"], { env: offline });
  assert.equal(schema.code, 1);
  assert.doesNotMatch(schema.stderr, /sites-literal:/);
  const unknown = await runCli(["--", "--missing"], { env: offline });
  assert.equal(unknown.code, 1);
  assert.doesNotMatch(unknown.stderr, /sites-literal:/);
});

test("explicit no-* booleans remain true flags, including disabling and repeated values", async () => {
  for (const flags of [
    ["--no-git"],
    ["--no-git=true"],
    ["--no-git", "true"],
    ["--no-git=false", "--no-git"],
  ]) {
    const cwd = tempDir();
    const result = await runCli(["init", ...flags], { cwd, env: offline });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  }
  const cwd = tempDir();
  const result = await runCli(
    ["init", "--no-git", "--no-git=false", "--template=static", "--no-git=false"],
    { cwd, env: offline },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), true);
});

test("completion uses native metadata with flag values in every command position", async () => {
  for (const words of [
    ["cli", ""],
    ["--quiet", "cli", ""],
    ["--quiet", "false", "cli", ""],
    ["cli", "--quiet=false", ""],
    ["--profile", "default", "cli", ""],
  ]) {
    const result = await runCli(["complete", "--", ...words], { env: offline });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^search$/m);
  }
  const flags = await runCli(["complete", "--", "info", "project", "--m"], { env: offline });
  assert.match(flags.stdout, /^--mcp$/m);
  const value = await runCli(["complete", "--", "list", "--cursor", ""], { env: offline });
  assert.equal(value.stdout, "");
  const hidden = await runCli(["complete", "--", "versions", ""], { env: offline });
  assert.doesNotMatch(hidden.stdout, /^get$/m);
});

test("success data and pagination remain bare, and schema finds commands in the registry", async () => {
  const mock = await createMockMcp((call) =>
    call.method === "tools/list"
      ? { result: { tools: [{ name: "sites.list_sites", inputSchema: { type: "object" } }] } }
      : {
          result: {
            structuredContent: { items: [{ project_id: "appgprj_fixture" }], cursor: "next-page" },
            content: [],
          },
        },
  );
  try {
    const env = { SITES_MCP_URL: mock.url, SITES_RETRY_BASE_MS: "1" };
    const list = await runCli(["--limit", "1", "list"], { env });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      items: [{ project_id: "appgprj_fixture" }],
      cursor: "next-page",
    });
    assert.equal(JSON.parse(list.stdout).ok, undefined);
    const schema = await runCli(["schema", "list"], { env });
    assert.equal(schema.code, 0, schema.stderr);
    assert.equal(JSON.parse(schema.stdout).name, "sites.list_sites");
  } finally {
    await mock.close();
  }
});

test("quiet is not consent, and only force can bypass destructive confirmation", async () => {
  const mock = await createMockMcp((call) => ({
    result: {
      structuredContent:
        call.name === "sites.delete_site"
          ? { was_deleted: true }
          : { project_id: "appgprj_fixture", slug: "fixture" },
      content: [],
    },
  }));
  try {
    const env = { SITES_MCP_URL: mock.url, SITES_RETRY_BASE_MS: "1" };
    const refused = await runCli(["delete", "appgprj_fixture", "--quiet"], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--force/);
    assert.equal(
      mock.calls.some((call) => call.name === "sites.delete_site"),
      false,
    );
    const accepted = await runCli(["delete", "appgprj_fixture", "--force"], { env });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(
      mock.calls.some((call) => call.name === "sites.delete_site"),
      true,
    );
  } finally {
    await mock.close();
  }
});

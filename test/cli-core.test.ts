// CLI core integration tests: foundation, auth, MCP, list/info.

import { test, vi } from "vite-plus/test";
import * as gunshiAgent from "gunshi/agent";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Collector,
  createMockAuth,
  createMockMcp,
  fakeJwt,
  runCli,
  tempDir,
  writeAuthFile,
} from "./helpers/index.ts";
import { parseSse, McpClient, VERSION } from "../src/mcp.ts";
import { decodeJwtExpiry } from "../src/auth.ts";
import { readManifest, writeManifest, writeState, readState } from "../src/manifest.ts";

vi.mock("gunshi/agent", () => ({
  getAgentProfile: vi.fn(() => ({ isAgent: false })),
}));

test("parseSse joins multi-line data and ignores comments", () => {
  const events = parseSse(
    ': ping\nevent: message\ndata: {"a":1,\ndata: "b":2}\n\ndata: second\n\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0], '{"a":1,\n"b":2}');
  assert.equal(events[1], "second");
});

test("decodeJwtExpiry reads exp claims", () => {
  const token = fakeJwt(1_700_000_000_000);
  assert.equal(decodeJwtExpiry(token), 1_700_000_000_000);
  assert.equal(decodeJwtExpiry("not-a-jwt"), null);
});

test("manifest and state round-trip", () => {
  const root = tempDir();
  writeManifest(root, { project_id: "appgprj_test", static: { directory: "dist" } });
  const { manifest } = readManifest(root);
  assert.equal(manifest.project_id, "appgprj_test");
  writeState(root, { last_commit_sha: "abc", tags: { latest: "appgver_1" } });
  assert.equal(readState(root).tags?.latest, "appgver_1");
});

test("--version and help", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "0.1.2");
  assert.equal(VERSION, "0.1.2");

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^  auth\s/m);
  assert.match(help.stdout, /^  list\s/m);

  const commandHelp = await runCli(["list", "--help"]);
  assert.equal(commandHelp.code, 0);
  assert.match(commandHelp.stdout, /USAGE:\s+sites list/);

  const groupHelp = await runCli(["auth", "--help"]);
  assert.equal(groupHelp.code, 0);
  assert.match(groupHelp.stdout, /sites auth --help/);
  assert.match(groupHelp.stdout, /whoami/);
});

test("usage errors use human stderr and exit 1", async () => {
  const noCommand = await runCli([]);
  assert.equal(noCommand.code, 0);
  assert.match(noCommand.stdout, /USAGE:\s+sites/);

  const unknown = await runCli(["bould"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^Error: Command not found/);

  const unsupported = await runCli(["list", "-z"]);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /^Error: /);

  const extraArg = await runCli(["info", "a", "b"]);
  assert.equal(extraArg.code, 1);
  assert.match(extraArg.stderr, /^Error: Expected 0 to 1 arguments/);

  const human = await runCli(["bogus", "--human"]);
  assert.equal(human.code, 1);
  assert.match(human.stderr, /^Error: /);

  const typo = await runCli(["deply", "--human"]);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /Did you mean `sites deploy`/);
});

test("help includes command discovery only when Gunshi detects an agent", async () => {
  const profile = vi.mocked(gunshiAgent.getAgentProfile);
  try {
    for (const isAgent of [true, false]) {
      profile.mockReturnValue({ isAgent });
      const version = await runCli(["--version"]);
      assert.equal(version.code, 0, version.stderr);
      assert.equal(version.stdout.trim(), "0.1.2");
      for (const argv of [["--help"], ["list", "--help"], ["auth", "--help"]]) {
        const result = await runCli(argv);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /USAGE:/);
        if (isAgent) {
          assert.match(result.stdout, /^=== STOP: AGENT COMMAND DISCOVERY ===/);
          assert.match(result.stdout, /sites cli search/);
          assert.match(result.stdout, /sites docs search/);
        } else {
          assert.doesNotMatch(result.stdout, /AGENT COMMAND DISCOVERY/);
        }
      }
    }
  } finally {
    profile.mockReset();
  }
});

test("--quiet=false keeps progress output enabled", async () => {
  const result = await runCli(["list", "--quiet=false", "--help"]);
  assert.equal(result.code, 0, result.stderr);
});

test("auth whoami uses SITES_ACCESS_TOKEN", async () => {
  const result = await runCli(["auth", "whoami"], {
    env: { SITES_ACCESS_TOKEN: fakeJwt(Date.now() + 3600_000) },
  });
  assert.equal(result.code, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.authenticated, true);
  assert.equal(body.authSource, "SITES_ACCESS_TOKEN");
  assert.equal(body.tokenValid, true);
  assert.equal(body.refreshTokenPresent, false);
  assert.equal(Object.hasOwn(body, "ok"), false);
  assert.equal(Object.hasOwn(body, "data"), false);
  assert.equal(Object.hasOwn(body, "meta"), false);
});

test("auth whoami reports unauthenticated as a successful result", async () => {
  const result = await runCli(["auth", "whoami"], {
    env: { SITES_ACCESS_TOKEN: undefined, SITES_AUTH_PATH: path.join(tempDir(), "missing.json") },
  });
  assert.equal(result.code, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.authenticated, false);
  assert.equal(body.error, "Not logged in");
});

test("auth whoami --check initializes over SSE", async () => {
  const mcp = await createMockMcp();
  try {
    const result = await runCli(["auth", "whoami", "--check", "--human"], {
      env: { SITES_MCP_URL: mcp.url },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Server: plugin-runtime/);
    assert.equal(mcp.calls[0].method, "initialize");
    assert.match(mcp.calls[0].headers["user-agent"] ?? "", /codex_cli_rs\/0\.1\.2/);
    assert.equal(mcp.calls[0].headers.authorization, "Bearer test-token");
    assert.equal(mcp.calls[0].headers["x-openai-product-sku"], "codex");
  } finally {
    await mcp.close();
  }
});

test("auth whoami reads the Codex file and reports the source", async () => {
  const dir = tempDir();
  const authFile = path.join(dir, "auth.json");
  writeAuthFile(authFile, {
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt(Date.now() + 3600_000),
      account_id: "acct_1",
      refresh_token: "r",
    },
  });
  const result = await runCli(["auth", "whoami"], {
    env: { SITES_ACCESS_TOKEN: undefined, SITES_AUTH_PATH: authFile },
  });
  assert.equal(result.code, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.accountId, "acct_1");
  assert.equal(body.authenticated, true);
  assert.match(body.authSource, /auth\.json\)$/);
});

test("expired token refreshes, rotates, and writes back atomically", async () => {
  const dir = tempDir();
  const authFile = path.join(dir, "auth.json");
  const oldToken = fakeJwt(Date.now() - 3600_000);
  const newToken = fakeJwt(Date.now() + 3600_000);
  writeAuthFile(authFile, {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "sk-keep-me",
    tokens: {
      access_token: oldToken,
      refresh_token: "old-refresh",
      account_id: "acct_1",
      id_token: "id-1",
    },
  });
  const auth = await createMockAuth(() => ({
    json: { access_token: newToken, refresh_token: "new-refresh", expires_in: 3600 },
  }));
  const mcp = await createMockMcp();
  try {
    const result = await runCli(["auth", "whoami", "--check"], {
      env: {
        SITES_ACCESS_TOKEN: undefined,
        SITES_AUTH_PATH: authFile,
        SITES_AUTH_URL: auth.url,
        SITES_MCP_URL: mcp.url,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0].grant_type, "refresh_token");
    assert.equal(auth.requests[0].refresh_token, "old-refresh");
    assert.equal(auth.requests[0].client_id, "app_EMoamEEZ73f0CkXaXp7hrann");

    const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(saved.tokens.access_token, newToken);
    assert.equal(saved.tokens.refresh_token, "new-refresh");
    assert.equal(saved.tokens.account_id, "acct_1");
    assert.equal(saved.OPENAI_API_KEY, "sk-keep-me");
    assert.equal(saved.auth_mode, "chatgpt");
    assert.ok(saved.last_refresh);
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
    assert.equal(mcp.calls[0].headers.authorization, `Bearer ${newToken}`);
  } finally {
    await mcp.close();
    await auth.close();
  }
});

test("401 triggers one forced refresh and retries", async () => {
  const dir = tempDir();
  const authFile = path.join(dir, "auth.json");
  const oldToken = fakeJwt(Date.now() + 3600_000);
  const newToken = fakeJwt(Date.now() + 3600_000, { session: "new" });
  writeAuthFile(authFile, {
    tokens: { access_token: oldToken, refresh_token: "old-refresh", account_id: "acct_1" },
  });
  const auth = await createMockAuth(() => ({
    json: { access_token: newToken, refresh_token: "new-refresh" },
  }));
  let toolCalls = 0;
  const mcp = await createMockMcp((call) => {
    if (call.method !== "tools/call") return undefined;
    toolCalls += 1;
    if (call.headers.authorization === `Bearer ${oldToken}`) {
      return { status: 401, body: "unauthorized" };
    }
    return { result: { structuredContent: { items: [], cursor: null } } };
  });
  try {
    const result = await runCli(["list"], {
      env: {
        SITES_ACCESS_TOKEN: undefined,
        SITES_AUTH_PATH: authFile,
        SITES_AUTH_URL: auth.url,
        SITES_MCP_URL: mcp.url,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(toolCalls, 2);
    assert.equal(auth.requests.length, 1);
    assert.equal(JSON.parse(result.stdout).items.length, 0);
  } finally {
    await mcp.close();
    await auth.close();
  }
});

test("expired token from SITES_ACCESS_TOKEN exits 1 without refresh", async () => {
  const expired = fakeJwt(Date.now() - 3600_000);
  const mcp = await createMockMcp();
  try {
    const result = await runCli(["list"], {
      env: { SITES_ACCESS_TOKEN: expired, SITES_MCP_URL: mcp.url },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /expired/i);
  } finally {
    await mcp.close();
  }
});

test("list prints items and follows cursor with --all", async () => {
  const pages = [
    {
      items: [{ id: "appgprj_1", slug: "one", access_mode: "custom", updated_at: "2026-01-01" }],
      cursor: "c1",
    },
    { items: [{ id: "appgprj_2", slug: "two", access_mode: "public" }], cursor: null },
  ];
  let index = 0;
  const mcp = await createMockMcp(
    (call) => {
      if (call.name !== "sites.list_sites") return undefined;
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return { result: { structuredContent: page } };
    },
    { sseDefault: false },
  );
  try {
    const result = await runCli(["list", "--all"], { env: { SITES_MCP_URL: mcp.url } });
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.deepEqual(
      body.items.map((item: { slug: string }) => item.slug),
      ["one", "two"],
    );
    assert.equal(mcp.calls.length, 2);
    assert.equal(mcp.calls[0].args?.limit, 100);
    assert.equal(mcp.calls[1].args?.cursor, "c1");
  } finally {
    await mcp.close();
  }
});

test("list validates limit and role", async () => {
  const badLimit = await runCli(["list", "--limit", "0"]);
  assert.equal(badLimit.code, 1);
  assert.match(badLimit.stderr, /--limit/);

  const badRole = await runCli(["list", "--role", "admin"]);
  assert.equal(badRole.code, 1);
  assert.match(badRole.stderr, /role/i);
});

test("info resolves a project_id from the manifest", async () => {
  const dir = tempDir();
  writeManifest(dir, { project_id: "appgprj_abc" });
  const mcp = await createMockMcp((call) => {
    if (call.name === "sites.get_site") {
      return {
        result: {
          structuredContent: {
            id: "appgprj_abc",
            slug: "demo",
            title: "Demo",
            url: null,
            access_mode: "custom",
            expected_url: "https://demo.chatgpt.site",
          },
        },
      };
    }
    if (call.name === "sites.list_site_versions") {
      return {
        result: {
          structuredContent: { items: [{ id: "appgprj_abc~appgver_1", version_number: 1 }] },
        },
      };
    }
    if (call.name === "sites.list_custom_domains") {
      return {
        result: { structuredContent: { items: [{ hostname: "example.com", status: "active" }] } },
      };
    }
    return undefined;
  });
  try {
    const result = await runCli(["info"], { env: { SITES_MCP_URL: mcp.url }, cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.project_id, "appgprj_abc");
    assert.equal(body.url, "https://demo.chatgpt.site");
    assert.equal(body.latest_version_number, 1);
    assert.equal(body.custom_domains[0].hostname, "example.com");
    assert.deepEqual(
      mcp.calls
        .filter((call) => call.method === "tools/call")
        .map((call) => call.name ?? "")
        .sort((left, right) => left.localeCompare(right)),
      ["sites.get_site", "sites.list_custom_domains", "sites.list_site_versions"],
    );
  } finally {
    await mcp.close();
  }
});

test("info accepts a slug and resolves it through list_sites", async () => {
  const mcp = await createMockMcp((call) => {
    if (call.name === "sites.list_sites") {
      return {
        result: { structuredContent: { items: [{ id: "appgprj_slug", slug: "my-site" }] } },
      };
    }
    if (call.name === "sites.get_site") {
      return {
        result: { structuredContent: { id: "appgprj_slug", slug: "my-site", title: "Mine" } },
      };
    }
    return { result: { structuredContent: { items: [] } } };
  });
  try {
    const result = await runCli(["info", "my-site"], {
      env: { SITES_MCP_URL: mcp.url },
      cwd: tempDir(),
    });
    assert.equal(result.code, 0, result.stderr);
    const getSite = mcp.calls.find((call) => call.name === "sites.get_site");
    assert.equal(getSite?.args?.project_id, "appgprj_slug");
  } finally {
    await mcp.close();
  }
});

test("info without a manifest or argument exits 1", async () => {
  const result = await runCli(["info"], { cwd: tempDir() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /project|manifest/i);
});

test("MCP tool errors render human messages with exit 1", async () => {
  const conflict = await createMockMcp(() => ({
    result: {
      isError: true,
      structuredContent: {
        error: "SitesConnectorError: slug already exists",
        error_code: "CONFLICT",
        error_data: { type: "slug_taken" },
      },
    },
  }));
  try {
    const result = await runCli(["list"], { env: { SITES_MCP_URL: conflict.url } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Error: slug already exists/);
  } finally {
    await conflict.close();
  }

  const notFound = await createMockMcp(() => ({
    result: {
      isError: true,
      structuredContent: { error: "not found", error_code: "NOT_FOUND" },
    },
  }));
  try {
    const result = await runCli(["list"], { env: { SITES_MCP_URL: notFound.url } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Error: not found/);
  } finally {
    await notFound.close();
  }
});

test("429 is retried with backoff", async () => {
  let toolCalls = 0;
  const mcp = await createMockMcp((call) => {
    if (call.name !== "sites.list_sites") return undefined;
    toolCalls += 1;
    if (toolCalls === 1) return { status: 429, body: "slow down", headers: { "retry-after": "0" } };
    return { result: { structuredContent: { items: [], cursor: null } } };
  });
  try {
    const result = await runCli(["list"], {
      env: { SITES_MCP_URL: mcp.url, SITES_RETRY_BASE_MS: "10" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(toolCalls, 2);
  } finally {
    await mcp.close();
  }
});

test("network failures exit 1", async () => {
  const result = await runCli(["list"], {
    env: { SITES_MCP_URL: "http://127.0.0.1:1/mcp", SITES_RETRY_BASE_MS: "1" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Error: /);
});

test("human output renders a table", async () => {
  const mcp = await createMockMcp((call) => {
    if (call.name === "sites.list_sites") {
      return {
        result: {
          structuredContent: { items: [{ id: "appgprj_1", slug: "one", access_mode: "custom" }] },
        },
      };
    }
    return undefined;
  });
  try {
    const result = await runCli(["list", "--human"], { env: { SITES_MCP_URL: mcp.url } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SLUG\s+PROJECT_ID/);
    assert.match(result.stdout, /one\s+appgprj_1/);
  } finally {
    await mcp.close();
  }
});

test("McpClient rejects an unexpected server", async () => {
  const mcp = await createMockMcp((call) =>
    call.method === "initialize"
      ? { result: { serverInfo: { name: "someone-else", version: "9" } } }
      : undefined,
  );
  try {
    const client = new McpClient(
      {
        token: "t",
        source: "test",
        expiresAt: null,
        accountId: null,
        refreshToken: null,
        refreshTokenPresent: false,
        path: null,
      },
      { url: mcp.url, env: {} },
    );
    await assert.rejects(
      client.initialize(),
      (error: { code?: string }) => error.code === "AUTH_SERVER_MISMATCH",
    );
  } finally {
    await mcp.close();
  }
});

test("stdout collector is independent of process.stdout", () => {
  const collector = new Collector();
  collector.write("x");
  assert.equal(collector.text, "x");
});

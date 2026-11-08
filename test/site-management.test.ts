// Versions, environment, access, domains, analytics, open/delete, doctor, and search.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockMcp, runCli, tempDir } from "./helpers/index.ts";
import type { MockCall, MockResponse } from "./helpers/index.ts";

function project(): string {
  const root = tempDir("sites-site-management-");
  fs.mkdirSync(path.join(root, ".openai"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".openai/hosting.json"),
    JSON.stringify({
      project_id: "appgprj_1",
      static: { directory: "dist", not_found_handling: "404-page" },
    }),
  );
  return root;
}

function structured(data: unknown): MockResponse {
  return { result: { structuredContent: data, content: [] } };
}

function callsNamed(calls: MockCall[], name: string): MockCall[] {
  return calls.filter((call) => call.name === name);
}

test("versions list and rollback use the recorded access mode", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.list_site_versions") {
      return structured({
        items: [
          { id: "appgprj_1~appgver_2", version_number: 2, source: { commit_sha: "bbbb" } },
          { id: "appgprj_1~appgver_1", version_number: 1, source: { commit_sha: "aaaa" } },
        ],
      });
    }
    if (call.name === "sites.get_site")
      return structured({ id: "appgprj_1", access_mode: "custom" });
    if (call.name === "sites.deploy_private_site_version") {
      return structured({ id: "dep_1", status: "pending", url: null });
    }
    return undefined;
  });
  try {
    const listed = await runCli(["versions", "list"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).data.items.length, 2);

    const rolled = await runCli(["versions", "rollback", "--previous"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(rolled.code, 0, rolled.stderr);
    const data = JSON.parse(rolled.stdout).data;
    assert.equal(data.version_id, "appgprj_1~appgver_1");
    assert.equal(data.deployment_id, "dep_1");
    assert.equal(callsNamed(mock.calls, "sites.deploy_private_site_version").length, 1);
  } finally {
    await mock.close();
  }
});

test("env get refuses secrets and pull writes a 0600 file", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_environment") {
      return structured({
        revision: 3,
        entries: [
          { key: "API_URL", value: "https://example.test", is_secret: false, type: "envvar" },
          { key: "TOKEN", value: null, is_secret: true, type: "envvar" },
        ],
      });
    }
    return undefined;
  });
  try {
    const secret = await runCli(["env", "get", "TOKEN"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(secret.code, 5);
    assert.match(secret.stderr, /ENV_SECRET_NOT_READABLE/);

    const outFile = path.join(root, "pulled.env");
    const pulled = await runCli(["env", "pull", "--out", outFile], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(pulled.code, 0, pulled.stderr);
    const content = fs.readFileSync(outFile, "utf8");
    assert.match(content, /^API_URL=https:\/\/example\.test$/m);
    assert.match(content, /# TOKEN \(secret/);
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
  } finally {
    await mock.close();
  }
});

test("access set validates combinations and waits for propagation", async () => {
  const root = project();
  let reads = 0;
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.update_site_access") return structured({});
    if (call.name === "sites.get_site") {
      reads += 1;
      return structured({ id: "appgprj_1", access_mode: reads > 1 ? "workspace_all" : "custom" });
    }
    return undefined;
  });
  try {
    const invalid = await runCli(["access", "set", "--public", "--allow-email", "a@example.test"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(invalid.code, 5);

    const changed = await runCli(["access", "set", "--workspace", "--wait"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url, SITES_RETRY_BASE_MS: "1" },
    });
    assert.equal(changed.code, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).data.access_mode, "workspace_all");
    assert.deepEqual(callsNamed(mock.calls, "sites.update_site_access")[0].args, {
      project_id: "appgprj_1",
      access_mode: "workspace_all",
    });
  } finally {
    await mock.close();
  }
});

test("domains add prints DNS instructions", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.add_custom_domain") {
      return structured({
        id: "dom_1",
        hostname: "www.example.com",
        status: "pending",
        cname_target: "custom-domains.chatgpt.site.",
        apex_proxy_ipv4_targets: ["162.159.143.30"],
        validation_records: [
          { record_type: "TXT", name: "_openai-site-verification.www", value: "abc" },
        ],
      });
    }
    return undefined;
  });
  try {
    const result = await runCli(["domains", "add", "www.example.com", "--human"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /CNAME\s+www\.example\.com\s+custom-domains\.chatgpt\.site\./);
    assert.match(result.stdout, /TXT\s+_openai-site-verification\.www\s+abc/);
  } finally {
    await mock.close();
  }
});

test("domains remove requires --force in non-interactive mode", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.list_custom_domains")
      return structured({ items: [{ id: "dom_1", hostname: "www.example.com" }] });
    if (call.name === "sites.remove_custom_domain")
      return structured({ id: "dom_1", hostname: "www.example.com" });
    return undefined;
  });
  try {
    const refused = await runCli(["domains", "remove", "www.example.com"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--force/);

    const removed = await runCli(["domains", "remove", "www.example.com", "--force", "--human"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /Removed www\.example\.com/);
  } finally {
    await mock.close();
  }
});

test("analytics summary aligns the window to UTC-08:00 hours", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_site_analytics_overview") return structured({ total_requests: 1 });
    return undefined;
  });
  try {
    const result = await runCli(["analytics", "summary", "--since", "2h"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    const args = callsNamed(mock.calls, "sites.get_site_analytics_overview")[0].args as {
      start_time_ms: number;
      end_time_ms: number;
      granularity: string;
    };
    assert.equal(args.granularity, "hour");
    assert.equal((args.start_time_ms + 8 * 3600_000) % 3600_000, 0);
    assert.equal((args.end_time_ms + 8 * 3600_000) % 3600_000, 0);
  } finally {
    await mock.close();
  }
});

test("open --print writes only the URL", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_site") {
      return structured({ id: "appgprj_1", slug: "demo", url: "https://demo.chatgpt.site" });
    }
    return undefined;
  });
  try {
    const result = await runCli(["open", "--path", "/docs?x=1", "--print"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "https://demo.chatgpt.site/docs?x=1\n");
  } finally {
    await mock.close();
  }
});

test("delete requires --force and clears project_id", async () => {
  const root = project();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_site") return structured({ id: "appgprj_1", slug: "demo" });
    if (call.name === "sites.delete_site")
      return structured({ project_id: "appgprj_1", was_deleted: true });
    return undefined;
  });
  try {
    const refused = await runCli(["delete"], { cwd: root, env: { SITES_MCP_URL: mock.url } });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--force/);

    const deleted = await runCli(["delete", "--force"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(deleted.code, 0, deleted.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".openai/hosting.json"), "utf8"));
    assert.equal(manifest.project_id, null);
  } finally {
    await mock.close();
  }
});

test("doctor --offline reports local checks without the API", async () => {
  const root = project();
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/index.html"), "<h1>ok</h1>");
  const result = await runCli(["doctor", "--offline"], { cwd: root });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout).data;
  assert.equal(report.failures, 0);
  assert.equal(report.checks.length, 12);
  assert.equal(report.checks.find((entry: { id: number }) => entry.id === 3).status, "skip");
});

test("doctor reports failures with exit 1", async () => {
  const root = tempDir("sites-doctor-");
  fs.mkdirSync(path.join(root, ".openai"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".openai/hosting.json"),
    JSON.stringify({ project_id: "appgprj_1", unknown: true }),
  );
  const result = await runCli(["doctor", "--offline"], { cwd: root });
  assert.equal(result.code, 1);
  assert.ok(JSON.parse(result.stdout).data.failures > 0);
});

test("cli search and docs search find entries", async () => {
  const cliResult = await runCli(["cli", "search", "deploy site"]);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const hits = JSON.parse(cliResult.stdout).data;
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length <= 5);
  assert.equal(hits[0].command, "sites deploy");
  assert.equal(typeof hits[0].summary, "string");

  const docsResult = await runCli(["docs", "search", "commit_sha"]);
  assert.equal(docsResult.code, 0, docsResult.stderr);
  assert.ok(Array.isArray(JSON.parse(docsResult.stdout).data));
});

test("schema lists and filters MCP tools", async () => {
  const mock = await createMockMcp((call) => {
    if (call.method === "tools/list") {
      return {
        result: {
          tools: [
            {
              name: "sites.list_sites",
              description: "List sites",
              inputSchema: { type: "object" },
            },
            { name: "sites.get_site", description: "Get a site", inputSchema: { type: "object" } },
          ],
        },
      };
    }
    return undefined;
  });
  try {
    const all = await runCli(["schema", "--list"], { env: { SITES_MCP_URL: mock.url } });
    assert.equal(all.code, 0, all.stderr);
    assert.equal(JSON.parse(all.stdout).data.length, 2);

    const missing = await runCli(["schema"], { env: { SITES_MCP_URL: mock.url } });
    assert.equal(missing.code, 1);

    const one = await runCli(["schema", "get_site"], { env: { SITES_MCP_URL: mock.url } });
    assert.equal(one.code, 0, one.stderr);
    assert.equal(JSON.parse(one.stdout).data.name, "sites.get_site");
  } finally {
    await mock.close();
  }
});

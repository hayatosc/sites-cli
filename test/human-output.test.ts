import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "vite-plus/test";
import { writeManifest } from "../src/manifest.ts";
import { createMockMcp, runCli, tempDir } from "./helpers/index.ts";

const site = {
  id: "appgprj_fixture",
  slug: "demo",
  title: "Demo",
  access_mode: "custom",
  url: "https://demo.chatgpt.site",
};

test("human list/info use the shared palette, preserve alignment and obey color opt-outs", async () => {
  const mock = await createMockMcp((call) => {
    const data =
      call.name === "sites.list_sites"
        ? { items: [site, { ...site, id: "appgprj_longer", slug: "long-demo" }] }
        : call.name === "sites.get_site"
          ? site
          : { items: [] };
    return call.method === "tools/call"
      ? { result: { structuredContent: data, content: [] } }
      : undefined;
  });
  try {
    const cwd = tempDir();
    writeManifest(cwd, { project_id: site.id });
    const env = { SITES_MCP_URL: mock.url, FORCE_COLOR: "1", NO_COLOR: undefined };
    for (const command of [["list"], ["info"]]) {
      const colored = await runCli([...command, "--human"], { cwd, env });
      assert.equal(colored.code, 0, colored.stderr);
      assert.ok(colored.stdout.includes("\u001b["));
      assert.ok(colored.stdout.includes(`\u001b[2m${site.id}\u001b[0m`));
      for (const [flags, override] of [
        [[], { NO_COLOR: "" }],
        [["--no-color"], {}],
        [[], { FORCE_COLOR: "0" }],
      ] as const) {
        const plain = await runCli([...command, "--human", ...flags], {
          cwd,
          env: { ...env, ...override },
        });
        assert.equal(plain.code, 0, plain.stderr);
        assert.ok(!plain.stdout.includes("\u001b["));
        assert.equal(plain.stdout, stripVTControlCharacters(colored.stdout));
      }
      const json = await runCli(command, { cwd, env });
      assert.equal(json.code, 0, json.stderr);
      assert.ok(!(json.stdout + json.stderr).includes("\u001b["));
      assert.ok(JSON.parse(json.stdout));
      if (command[0] === "list") {
        assert.ok(colored.stdout.includes("\u001b[36mSLUG\u001b[0m"));
        const lines = stripVTControlCharacters(colored.stdout).trimEnd().split("\n");
        assert.deepEqual(
          lines.map((line) => line.search(/PROJECT_ID|appgprj_/)),
          [11, 11, 11],
        );
      } else {
        assert.ok(colored.stdout.includes("\u001b[1mSite:\u001b[0m"));
        assert.ok(colored.stdout.includes("\u001b[36;4mhttps://demo.chatgpt.site\u001b[0m"));
      }
    }
  } finally {
    await mock.close();
  }
});

test("remaining human renderers use semantic colors without changing machine data", async () => {
  const domain = {
    id: "domain_fixture",
    hostname: "www.example.test",
    status: "active",
    ssl_status: "pending",
    cname_target: "proxy.example.test",
    apex_proxy_ipv4_targets: ["192.0.2.1"],
    validation_records: [{ name: "_verify", value: "verification" }],
  };
  const version = {
    id: "version_fixture",
    version_number: 1,
    source: { commit_sha: "abcdef1234567890" },
    deployment_id: "deployment_fixture",
  };
  const tools = ["list_sites", "get_site", "list_site_versions", "list_custom_domains"].map(
    (name) => ({ name: `sites.${name}`, inputSchema: { type: "object" } }),
  );
  const mock = await createMockMcp((call) => {
    if (call.method === "tools/list") return { result: { tools } };
    if (call.method !== "tools/call") return;
    const responses: Record<string, unknown> = {
      "sites.get_site": site,
      "sites.get_environment": {
        revision: 1,
        entries: [
          { key: "GREETING", value: "hello", type: "envvar" },
          { key: "SECRET", is_secret: true },
        ],
      },
      "sites.list_site_versions": { items: [version] },
      "sites.get_site_version": version,
      "sites.get_deployment_status": {
        id: "deployment_fixture",
        status: "succeeded",
        url: site.url,
      },
      "sites.deploy_private_site_version": {
        id: "deployment_fixture",
        status: "pending",
        url: site.url,
      },
      "sites.get_site_worker_logs": {
        events: [
          {
            id: "log_fixture",
            timestamp: "2026-11-09T12:00:00Z",
            level: "error",
            message: "example log",
          },
        ],
      },
      "sites.list_custom_domains": { items: [domain] },
      "sites.add_custom_domain": domain,
      "sites.refresh_custom_domain_status": domain,
      "sites.remove_custom_domain": { ...domain, status: "deleted" },
      "sites.get_site_analytics_overview": { overall: { requests: 3 } },
      "sites.list_site_analytics_events": {
        events: [{ timestamp: "2026-11-09T12:00:00Z", name: "visit" }],
      },
      "sites.check_slug_availability": { available: true },
      "sites.create_site": site,
      "sites.create_source_repository_write_credential": {
        remote_url: "https://example.test/source.git",
        branch: "main",
        token: "fixture",
      },
      "sites.delete_site": { project_id: site.id, was_deleted: true },
    };
    return { result: { structuredContent: responses[call.name ?? ""] ?? {}, content: [] } };
  });
  const commands = [
    ["auth", "whoami"],
    ["auth", "whoami", "--check"],
    ["status", "deployment_fixture"],
    ["logs"],
    ["versions", "list"],
    ["versions", "show", version.id],
    ["versions", "get", version.id],
    ["versions", "rollback", version.id, "--force"],
    ["env", "list"],
    ["env", "set", "GREETING=hello"],
    ["env", "unset", "GREETING", "--force"],
    ["env", "pull"],
    ["env", "push"],
    ["env", "push", "--dry-run"],
    ["access", "show"],
    ["access", "set", "--private"],
    ["domains", "list"],
    ["domains", "add", domain.hostname],
    ["domains", "get", domain.id],
    ["domains", "refresh", domain.id],
    ["domains", "remove", domain.id, "--force"],
    ["analytics", "summary"],
    ["analytics", "events"],
    ["docs", "search", "deploy"],
    ["cli", "search", "deploy"],
    ["schema", "--list"],
    ["schema", "sites.get_site"],
    ["schema", "list"],
    ["schema", "info"],
    ["tools"],
    ["create", "fixture"],
    ["create", "fixture", "--dry-run"],
    ["open", "--print"],
    ["delete", "--force"],
    ["deploy", "--dry-run", "--prebuilt"],
    ["versions", "create", "--dry-run", "--prebuilt"],
  ];
  try {
    const env = { SITES_MCP_URL: mock.url, FORCE_COLOR: "1", NO_COLOR: undefined };
    for (const command of commands) {
      const cwd = tempDir();
      writeManifest(cwd, {
        project_id: command[0] === "create" ? null : site.id,
        static: { directory: "dist" },
      });
      fs.mkdirSync(path.join(cwd, "dist"));
      fs.writeFileSync(path.join(cwd, "dist/index.html"), "fixture");
      fs.writeFileSync(path.join(cwd, ".env"), "GREETING=hello\n");
      fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ private: true }));
      const colored = await runCli([...command, "--human"], { cwd, env });
      assert.equal(colored.code, 0, `${command.join(" ")}: ${colored.stderr}`);
      assert.ok(colored.stdout.includes("\u001b["), command.join(" "));
      if (command.includes("--prebuilt")) {
        assert.ok(
          colored.stderr.includes(
            "\u001b[33mwarning: No lockfile found; dependency versions may not be reproducible.\u001b[0m",
          ),
        );
      }
      // Mutating mock commands may update the local manifest; restore it before the machine run.
      writeManifest(cwd, {
        project_id: command[0] === "create" ? null : site.id,
        static: { directory: "dist" },
      });
      const json = await runCli(command, { cwd, env });
      assert.equal(json.code, 0, `${command.join(" ")}: ${json.stderr}`);
      assert.ok(!(json.stdout + json.stderr).includes("\u001b["), command.join(" "));
      if (command[0] !== "open") assert.ok(JSON.parse(json.stdout));
      if (command[0] === "domains" && command[1] === "list") {
        assert.ok(colored.stdout.includes("\u001b[32mactive\u001b[0m"));
        assert.ok(colored.stdout.includes("\u001b[33mpending\u001b[0m"));
      }
    }
    const cwd = tempDir();
    writeManifest(cwd, { project_id: site.id });
    const raw = await runCli(["env", "get", "GREETING", "--human"], { cwd, env });
    assert.equal(raw.stdout, "hello\n");
    fs.mkdirSync(path.join(cwd, "dist"));
    const doctor = await runCli(["doctor", "--offline", "--human"], { cwd, env });
    assert.equal(doctor.code, 1);
    assert.ok(doctor.stdout.includes("\u001b[32m✓\u001b[0m"));
    assert.ok(doctor.stdout.includes("\u001b[33m!\u001b[0m"));
    assert.ok(doctor.stdout.includes("\u001b[31;1m✗\u001b[0m"));
  } finally {
    await mock.close();
  }
});

test("human command help colors section headings without changing plain help or version", async () => {
  const env = { FORCE_COLOR: "1", NO_COLOR: undefined };
  const colored = await runCli(["list", "--help", "--human"], { env });
  assert.equal(colored.code, 0, colored.stderr);
  assert.ok(colored.stdout.includes("\u001b[36mUSAGE:\u001b[0m"));
  const plain = await runCli(["list", "--help", "--human", "--no-color"], { env });
  assert.equal(stripVTControlCharacters(colored.stdout), plain.stdout);
  assert.ok(!plain.stdout.includes("\u001b["));
  const version = await runCli(["--version", "--human"], { env });
  assert.equal(version.stdout.trim(), "0.1.2");
});

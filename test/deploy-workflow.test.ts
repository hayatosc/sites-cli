// Site creation, source sync, deployment, status, and logs.

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createMockMcp, runCli, tempDir } from "./helpers/index.ts";
import type { MockCall, MockResponse } from "./helpers/index.ts";

const BUILD_SCRIPT = `import fs from "node:fs";
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("public/index.html", "dist/index.html");
`;

function makeProject(): { root: string; remote: string } {
  const root = tempDir("sites-deploy-");
  fs.mkdirSync(path.join(root, ".openai"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".openai/hosting.json"),
    JSON.stringify({
      project_id: "appgprj_1",
      static: { directory: "dist", not_found_handling: "404-page" },
    }),
  );
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "public/index.html"), "<h1>hello</h1>");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts/build.mjs"), BUILD_SCRIPT);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node scripts/build.mjs" } }),
  );
  const remote = path.join(tempDir("sites-remote-"), "repo.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  return { root, remote: `file://${remote}` };
}

function structured(data: unknown): MockResponse {
  return { result: { structuredContent: data, content: [] } };
}

async function createUploadServer(): Promise<{
  base: string;
  calls: string[];
  close: () => Promise<void>;
}> {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/backend-api/files") {
      const { port } = server.address() as AddressInfo;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ file_id: "file_1", upload_url: `http://127.0.0.1:${port}/blob/file_1` }),
      );
      return;
    }
    if (req.method === "PUT" && req.url === "/blob/file_1") {
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/files/file_1/uploaded") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          download_url: "https://files.test/site.tar.gz",
          file_name: "site.tar.gz",
          file_size_bytes: body.length,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("create dry-run does not touch the API", async () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, ".openai/hosting.json"), JSON.stringify({ project_id: null }));
  const result = await runCli(["create", "my-site", "--dry-run"], {
    cwd: root,
    env: { SITES_MCP_URL: "http://127.0.0.1:1/mcp" },
  });
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.slug, "my-site");
  assert.equal(json.project_id, "(dry-run)");
});

test("create stores the project id and applies access mode", async () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, ".openai/hosting.json"), JSON.stringify({ project_id: null }));
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.check_slug_availability")
      return structured({ slug: "new-site", available: true });
    if (call.name === "sites.create_site") {
      return structured({
        id: "appgprj_new",
        slug: "new-site",
        expected_url: "https://new-site.chatgpt.site",
      });
    }
    if (call.name === "sites.create_source_repository_write_credential") {
      return structured({
        remote_url: "https://example.test/repo.git",
        branch: "main",
        token: "t",
      });
    }
    return undefined;
  });
  try {
    const result = await runCli(["create", "new-site", "--public", "--title", "New"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.project_id, "appgprj_new");
    assert.equal(json.access_mode, "public");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".openai/hosting.json"), "utf8"));
    assert.equal(manifest.project_id, "appgprj_new");
    const access = mock.calls.find((call) => call.name === "sites.update_site_access");
    assert.deepEqual(access?.args, { project_id: "appgprj_new", access_mode: "public" });
  } finally {
    await mock.close();
  }
});

test("create stops when the slug is taken", async () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, ".openai/hosting.json"), JSON.stringify({ project_id: null }));
  const mock = await createMockMcp((call) =>
    call.name === "sites.check_slug_availability" ? structured({ available: false }) : undefined,
  );
  try {
    const result = await runCli(["create", "taken"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already in use/);
  } finally {
    await mock.close();
  }
});

test("status returns exit 1 when the deployment failed", async () => {
  const { root } = makeProject();
  fs.mkdirSync(path.join(root, ".sites"));
  fs.writeFileSync(
    path.join(root, ".sites/state.json"),
    JSON.stringify({ last_deployment_id: "dep_1" }),
  );
  const mock = await createMockMcp(() =>
    structured({ id: "dep_1", status: "failed", failure_message: "boom", url: null }),
  );
  try {
    const result = await runCli(["status"], { cwd: root, env: { SITES_MCP_URL: mock.url } });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).status, "failed");
  } finally {
    await mock.close();
  }
});

test("status --watch polls until success", async () => {
  const { root } = makeProject();
  let statusCalls = 0;
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_deployment_status") {
      statusCalls += 1;
      const status = statusCalls < 3 ? "publishing" : "succeeded";
      return structured({
        id: "dep_9",
        status,
        url: status === "succeeded" ? "https://x.chatgpt.site" : null,
      });
    }
    return undefined;
  });
  try {
    const result = await runCli(["status", "dep_9", "--watch", "--interval", "1"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "succeeded");
    assert.equal(statusCalls, 3);
  } finally {
    await mock.close();
  }
});

test("logs validates --since and forwards filters", async () => {
  const { root } = makeProject();
  const bad = await runCli(["logs", "--since", "yesterday"], { cwd: root });
  assert.equal(bad.code, 1);

  const mock = await createMockMcp(() =>
    structured({
      events: [
        { timestamp: "2026-11-07T00:00:00Z", level: "error", message: "first" },
        { timestamp: "2026-11-07T00:01:00Z", level: "error", message: "second" },
      ],
    }),
  );
  try {
    const result = await runCli(["logs", "--since", "2h", "--errors-only", "--human"], {
      cwd: root,
      env: { SITES_MCP_URL: mock.url },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /second/);
    const call = mock.calls.find((item) => item.name === "sites.get_site_worker_logs");
    assert.deepEqual(call?.args, {
      project_id: "appgprj_1",
      since_minutes: 120,
      limit: 100,
      errors_only: true,
    });
  } finally {
    await mock.close();
  }
});

test("deploy --dry-run builds without credentials", async () => {
  const { root } = makeProject();
  const result = await runCli(["deploy", "--dry-run", "--human"], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dry run OK/);
  assert.ok(fs.existsSync(path.join(root, "dist/index.html")));

  const json = await runCli(["deploy", "--dry-run"], { cwd: root });
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.detection.package_manager, "npm");
  assert.equal(body.detection.build_script, "build");
  assert.equal(body.detection.kind, "static");
});

test("human deploy progress honors color overrides on pipes", async () => {
  const { root } = makeProject();
  for (const variant of ["forced", "no-color", "NO_COLOR", "plain", "quiet"]) {
    const result = await runCli(
      [
        "deploy",
        "--dry-run",
        "--human",
        ...(variant === "no-color" ? ["--no-color"] : []),
        ...(variant === "quiet" ? ["--quiet"] : []),
      ],
      {
        cwd: root,
        env: {
          FORCE_COLOR: variant === "plain" ? undefined : "1",
          NO_COLOR: variant === "NO_COLOR" ? "1" : undefined,
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    if (variant === "forced") {
      assert.ok(result.stderr.includes("\u001b[36mPreflight\u001b[0m"));
      assert.ok(result.stderr.includes("\u001b[32m✓\u001b[0m Build complete"));
      assert.ok(result.stderr.includes("\u001b[2mbuild: script"));
    } else {
      assert.ok(!(result.stdout + result.stderr).includes("\u001b["));
    }
    if (variant === "quiet") assert.equal(result.stdout + result.stderr, "");
    else assert.match(result.stdout, /Dry run OK/);
  }
  const json = await runCli(["deploy", "--dry-run"], {
    cwd: root,
    env: { FORCE_COLOR: "1", NO_COLOR: undefined },
  });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).dry_run, true);
  assert.ok(!json.stdout.includes("\u001b["));
});

test("deploy uploads, saves, polls, and records state", async () => {
  const { root, remote } = makeProject();
  fs.writeFileSync(path.join(root, "vars.env"), "PLAIN_VALUE=plain\n");
  fs.writeFileSync(
    path.join(root, "secrets.env"),
    "SECRET_TOKEN=abc123\nEXPANDED_SECRET=${SECRET_TOKEN}-suffix\n",
  );
  const upload = await createUploadServer();
  let statusIndex = 0;
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_site") {
      return structured({
        id: "appgprj_1",
        slug: "demo",
        access_mode: "custom",
        url: "https://demo.chatgpt.site",
      });
    }
    if (call.name === "sites.create_source_repository_write_credential") {
      return structured({ remote_url: remote, branch: "main", token: "secret-token" });
    }
    if (call.name === "sites.save_site_version") {
      const archive = call.args?.archive as Record<string, unknown>;
      assert.equal(typeof archive.file_id, "string");
      return structured({ id: "appgprj_1~appgver_1", version_number: 1 });
    }
    if (call.name === "sites.deploy_private_site_version") {
      return structured({ id: "dep_1", status: "pending" });
    }
    if (call.name === "sites.get_deployment_status") {
      statusIndex += 1;
      return structured({
        id: "dep_1",
        status: statusIndex < 2 ? "publishing" : "succeeded",
        url: "https://demo.chatgpt.site",
      });
    }
    return undefined;
  });
  try {
    const result = await runCli(
      [
        "deploy",
        "--human",
        "--tag",
        "v1",
        "--timeout",
        "10",
        "--env-file",
        "vars.env",
        "--secrets-file",
        "secrets.env",
      ],
      {
        cwd: root,
        env: {
          FORCE_COLOR: "1",
          NO_COLOR: undefined,
          SITES_MCP_URL: mock.url,
          SITES_API_BASE: upload.base,
          SITES_ALLOW_INSECURE_GIT: "1",
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Deployed appgprj_1/);
    assert.ok(result.stdout.includes("URL: \u001b[32mhttps://demo.chatgpt.site\u001b[0m"));
    assert.ok(result.stderr.includes("\u001b[32m✓\u001b[0m Deploy complete"));
    const save = mock.calls.find((call) => call.name === "sites.save_site_version") as MockCall;
    assert.deepEqual(save.args?.archive, {
      download_url: "https://files.test/site.tar.gz",
      file_id: "file_1",
      mime_type: "application/gzip",
      file_name: "site.tar.gz",
    });
    assert.equal(typeof save.args?.commit_sha, "string");
    const commitSha = save.args?.commit_sha;
    assert.ok(typeof commitSha === "string");
    assert.equal(commitSha.length, 40);
    const deployCall = mock.calls.find((call) => call.name === "sites.deploy_private_site_version");
    assert.equal(deployCall?.args?.version_id, "appgprj_1~appgver_1");
    assert.ok(upload.calls.includes("POST /backend-api/files"));
    assert.ok(upload.calls.includes("PUT /blob/file_1"));
    const environmentCall = mock.calls.find(
      (call) => call.name === "sites.update_environment_variables",
    ) as MockCall;
    const setValues = environmentCall.args?.set_values as Array<Record<string, unknown>>;
    assert.deepEqual(
      setValues.map((entry) => [entry.key, entry.value, entry.is_secret]),
      [
        ["PLAIN_VALUE", "plain", false],
        ["SECRET_TOKEN", "abc123", true],
        ["EXPANDED_SECRET", "abc123-suffix", true],
      ],
    );
    assert.ok(!result.stderr.includes("abc123"));
    const state = JSON.parse(fs.readFileSync(path.join(root, ".sites/state.json"), "utf8"));
    assert.equal(state.last_deployment_id, "dep_1");
    assert.equal(state.tags.v1, "appgprj_1~appgver_1");
    assert.ok(!result.stderr.includes("secret-token"));
  } finally {
    await mock.close();
    await upload.close();
  }
});

for (const accessMode of ["custom", "public"])
  test(`versions create uploads without deployment or audience/env changes (${accessMode})`, async () => {
    const { root, remote } = makeProject();
    fs.mkdirSync(path.join(root, ".sites"));
    fs.writeFileSync(
      path.join(root, ".sites/state.json"),
      JSON.stringify({
        last_deployment_id: "live_dep",
        last_version_id: "live_version",
        last_artifact_hash: "live_hash",
        tags: { live: "live_version" },
      }),
    );
    fs.writeFileSync(
      path.join(root, ".sites/conversion-env.json"),
      JSON.stringify({ vars: { MUST_NOT_APPLY: "must-not-leak" } }),
    );
    const upload = await createUploadServer();
    const mock = await createMockMcp((call) => {
      if (call.name === "sites.get_site")
        return structured({ id: "appgprj_1", access_mode: accessMode });
      if (call.name === "sites.create_source_repository_write_credential")
        return structured({ remote_url: remote, branch: "main", token: "secret-token" });
      if (call.name === "sites.save_site_version")
        return structured({ id: "draft_version", version_number: 2 });
      assert.equal(call.method, "initialize", `Unexpected remote operation: ${call.name}`);
      return undefined;
    });
    try {
      const result = await runCli(["versions", "create", "--tag", "draft"], {
        cwd: root,
        env: {
          SITES_MCP_URL: mock.url,
          SITES_API_BASE: upload.base,
          SITES_ALLOW_INSECURE_GIT: "1",
        },
      });
      assert.equal(result.code, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.status, "uploaded");
      assert.equal(body.deployment_id, null);
      assert.equal(body.access_mode, accessMode);
      assert.deepEqual(
        mock.calls.filter((call) => call.name).map((call) => call.name),
        [
          "sites.get_site",
          "sites.create_source_repository_write_credential",
          "sites.save_site_version",
        ],
      );
      const save = mock.calls.find((call) => call.name === "sites.save_site_version");
      assert.deepEqual(save?.args?.archive, {
        download_url: "https://files.test/site.tar.gz",
        file_id: "file_1",
        mime_type: "application/gzip",
        file_name: "site.tar.gz",
      });
      assert.deepEqual(upload.calls, [
        "POST /backend-api/files",
        "PUT /blob/file_1",
        "POST /backend-api/files/file_1/uploaded",
      ]);
      const state = JSON.parse(fs.readFileSync(path.join(root, ".sites/state.json"), "utf8"));
      assert.equal(state.last_deployment_id, "live_dep");
      assert.equal(state.last_version_id, "live_version");
      assert.equal(state.last_artifact_hash, "live_hash");
      assert.equal(state.last_uploaded_version_id, "draft_version");
      assert.equal(state.tags.live, "live_version");
      assert.equal(state.tags.draft, "draft_version");
      assert.doesNotMatch(result.stdout + result.stderr, /must-not-leak|secret-token/);
    } finally {
      await mock.close();
      await upload.close();
    }
  });

test("versions create native dry-run builds offline without touching uploaded/deployed state", async () => {
  const { root } = makeProject();
  const result = await runCli(["versions", "create", "--dry-run"], {
    cwd: root,
    env: { SITES_ACCESS_TOKEN: undefined, SITES_AUTH_PATH: path.join(root, "missing-auth.json") },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dry_run, true);
  assert.ok(fs.existsSync(path.join(root, "dist/index.html")));
  assert.equal(fs.existsSync(path.join(root, ".sites/state.json")), false);
});

test("deploy without source sync uses the current commit", async () => {
  const { root } = makeProject();
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n.sites/\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
    cwd: root,
  });

  const upload = await createUploadServer();
  const mock = await createMockMcp((call) => {
    if (call.name === "sites.get_site")
      return structured({ id: "appgprj_1", access_mode: "custom" });
    if (call.name === "sites.save_site_version") return structured({ id: "v1", version_number: 1 });
    if (call.name === "sites.deploy_private_site_version")
      return structured({ id: "dep_2", status: "pending" });
    if (call.name === "sites.get_deployment_status")
      return structured({ id: "dep_2", status: "succeeded", url: "https://demo.chatgpt.site" });
    return undefined;
  });
  try {
    const result = await runCli(
      ["deploy", "--no-source-sync", "--allow-dirty", "--timeout", "10"],
      {
        cwd: root,
        env: { SITES_MCP_URL: mock.url, SITES_API_BASE: upload.base },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const save = mock.calls.find((call) => call.name === "sites.save_site_version");
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    assert.equal(save?.args?.commit_sha, expected);
  } finally {
    await mock.close();
    await upload.close();
  }
});

test("deploy --prebuilt uses existing output without running the build", async () => {
  const { root } = makeProject();
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/index.html"), "<h1>prebuilt</h1>");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','yes')\"" },
    }),
  );
  fs.writeFileSync(path.join(root, "secrets.env"), "TOKEN=from-file\nDERIVED=${TOKEN}-suffix\n");

  const result = await runCli(
    ["deploy", "--dry-run", "--prebuilt", "--secrets-file", "secrets.env", "--human"],
    { cwd: root },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dry run OK/);
  assert.equal(fs.readFileSync(path.join(root, "dist/index.html"), "utf8"), "<h1>prebuilt</h1>");
  assert.ok(!fs.existsSync(path.join(root, "built.txt")));

  const json = await runCli(
    ["deploy", "--dry-run", "--prebuilt", "--secrets-file", "secrets.env"],
    { cwd: root },
  );
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.deepEqual(body.environment.keys, ["TOKEN", "DERIVED"]);
  assert.deepEqual(body.environment.secret_keys, ["TOKEN", "DERIVED"]);
});

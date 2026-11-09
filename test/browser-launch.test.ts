// Verify URL launch plans without opening a browser or executing a shell.
import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import * as subprocess from "../src/subprocess.ts";
import { writeManifest } from "../src/manifest.ts";
import { createMockMcp, runCli, tempDir } from "./helpers/index.ts";

for (const failure of [false, true]) {
  test(`Windows browser URL uses a native handler, ${failure ? "reporting startup failure" : "retaining metacharacters as URL data"}`, async () => {
    const root = tempDir();
    writeManifest(root, { project_id: "appgprj_browser_fixture" });
    const mock = await createMockMcp(() => ({
      result: { structuredContent: { url: "https://fixture.example/" }, content: [] },
    }));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const launcher = vi.spyOn(subprocess, "spawnCommand").mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() =>
        child.emit(
          failure ? "error" : "spawn",
          failure ? new Error("fixture startup failure") : undefined,
        ),
      );
      return child;
    });
    try {
      const suffix = '/?q=two words&quoted="value"&literal=%PATH%|data';
      const result = await runCli(["open", "--path", suffix], {
        cwd: root,
        env: { SITES_MCP_URL: mock.url },
      });
      assert.equal(result.code, failure ? 1 : 0, result.stderr);
      assert.equal(launcher.mock.calls.length, 1);
      assert.deepEqual(launcher.mock.calls[0], [
        "rundll32.exe",
        ["url.dll,FileProtocolHandler", new URL(suffix, "https://fixture.example/").toString()],
        { detached: true, stdio: "ignore" },
      ]);
      if (failure) assert.match(result.stderr, /BROWSER_OPEN_FAILED/);
      else assert.equal(JSON.parse(result.stdout).data.opened, true);
    } finally {
      launcher.mockRestore();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      await mock.close();
    }
  });
}

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { colorEnabled } from "../src/output.ts";
import type { Env } from "../src/types.ts";

const cases: Array<{
  name: string;
  tty?: boolean;
  env?: Env;
  options?: Record<string, unknown>;
  expected: boolean;
}> = [
  { name: "TTY", tty: true, expected: true },
  { name: "pipe", expected: false },
  { name: "FORCE_COLOR on pipe", env: { FORCE_COLOR: "1" }, expected: true },
  { name: "empty FORCE_COLOR", env: { FORCE_COLOR: "" }, expected: true },
  { name: "FORCE_COLOR=0", tty: true, env: { FORCE_COLOR: "0" }, expected: false },
  { name: "NO_COLOR on TTY", tty: true, env: { NO_COLOR: "1" }, expected: false },
  { name: "NO_COLOR beats FORCE_COLOR", env: { NO_COLOR: "1", FORCE_COLOR: "1" }, expected: false },
  { name: "empty NO_COLOR beats FORCE_COLOR", env: { NO_COLOR: "", FORCE_COLOR: "1" }, expected: false },
  { name: "--no-color beats FORCE_COLOR", options: { "no-color": true }, env: { FORCE_COLOR: "1" }, expected: false },
];

for (const entry of cases) {
  test(`color precedence: ${entry.name}`, () => {
    assert.equal(
      colorEnabled({ write: () => {}, isTTY: entry.tty }, entry.options ?? {}, entry.env ?? {}),
      entry.expected,
    );
  });
}

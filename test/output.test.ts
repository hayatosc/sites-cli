import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { colorEnabled, printError, renderTable } from "../src/output.ts";
import { createStyle, padEndVisible, visibleWidth } from "../src/style.ts";
import { CliError } from "../src/errors.ts";
import type { Env } from "../src/types.ts";

test("shared palette uses semantic ANSI codes only when enabled", () => {
  const codes = {
    heading: "36",
    label: "1",
    value: null,
    dim: "2",
    id: "2",
    success: "32",
    ok: "32",
    warn: "33",
    error: "31",
    url: "36;4",
  } as const;
  for (const enabled of [true, false]) {
    const style = createStyle(enabled);
    for (const name of Object.keys(codes) as Array<keyof typeof codes>) {
      const code = codes[name];
      assert.equal(
        style[name]("text"),
        enabled && code ? `\u001b[${code}mtext\u001b[0m` : "text",
        name,
      );
    }
    assert.equal(style.ok("✓"), enabled ? "\u001b[32m✓\u001b[0m" : "✓");
  }
});

test("status palette preserves text and colors recognized states", () => {
  for (const [states, code] of [
    [["live", "ready", "success", "succeeded", "ok"], "32"],
    [["pending", "building", "waiting"], "33"],
    [["failed", "error", "deleted"], "31"],
  ] as const) {
    for (const state of states) {
      assert.equal(createStyle(true).status(state), `\u001b[${code}m${state}\u001b[0m`);
      assert.equal(createStyle(false).status(state), state);
    }
  }
  assert.equal(createStyle(true).status("READY"), "\u001b[32mREADY\u001b[0m");
  assert.equal(createStyle(true).status("custom-state"), "custom-state");
});

test("visible width and padding ignore terminal escape sequences", () => {
  const text = createStyle(true).url("demo");
  assert.equal(visibleWidth(text), 4);
  assert.equal(visibleWidth(""), 0);
  assert.equal(visibleWidth("plain"), 5);
  assert.equal(padEndVisible(text, 7), text + "   ");
  assert.equal(padEndVisible(text, 2), text);
  assert.equal(padEndVisible("plain", 7), "plain  ");
  assert.equal(visibleWidth("\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007"), 4);
});

test("shared tables align colored headers and cells by visible width", () => {
  const style = createStyle(true);
  let output = "";
  renderTable(
    {
      write: (text) => {
        output += text;
      },
    },
    [style.heading("SITE"), style.heading("STATUS")],
    [
      [style.id("long-demo"), style.status("ready")],
      [style.id("x"), style.status("failed")],
    ],
  );
  assert.ok(output.includes(style.status("ready")));
  assert.equal(
    stripVTControlCharacters(output),
    "SITE       STATUS\nlong-demo  ready\nx          failed\n",
  );
  assert.deepEqual(
    output
      .trimEnd()
      .split("\n")
      .map((line) => stripVTControlCharacters(line).search(/STATUS|ready|failed/)),
    [11, 11, 11],
  );
});

test("shared error renderer uses the palette without coloring plain output", () => {
  for (const color of [true, false]) {
    let output = "";
    printError(new CliError("TEST", "broken", { hint: "retry", docs: "https://example.test" }), {
      stderr: {
        write: (text) => {
          output += text;
        },
      },
      color,
    });
    assert.equal(
      stripVTControlCharacters(output),
      "Error: broken\n  hint: retry\n  docs: https://example.test\n",
    );
    assert.ok(output.startsWith(color ? "\u001b[31mError: \u001b[0m" : "Error: "));
  }
});

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
  {
    name: "empty NO_COLOR beats FORCE_COLOR",
    env: { NO_COLOR: "", FORCE_COLOR: "1" },
    expected: false,
  },
  {
    name: "--no-color beats FORCE_COLOR",
    options: { "no-color": true },
    env: { FORCE_COLOR: "1" },
    expected: false,
  },
];

for (const entry of cases) {
  test(`color precedence: ${entry.name}`, () => {
    assert.equal(
      colorEnabled({ write: () => {}, isTTY: entry.tty }, entry.options ?? {}, entry.env ?? {}),
      entry.expected,
    );
  });
}

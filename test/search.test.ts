// Fixed audit corpus: regression evidence, not production traffic or semantic search.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createCommands } from "../src/commands/index.ts";
import { searchCommands } from "../src/commands/docs.ts";

const commands = createCommands();
const names = commands
  .filter((command) => !command.hidden)
  .map((command) => command.path.join(" "));
const results = (query: string) =>
  searchCommands(commands, query).map((hit) => hit.command.replace(/^sites /, ""));

test("every visible command remains discoverable by exact name and prefix", () => {
  for (const name of names) {
    assert.equal(results(name)[0], name);
    assert.equal(results(`sites ${name}`)[0], name);
    assert.ok(results(name.slice(0, -1)).includes(name), name);
  }
  for (const query of ["versions", "tools", "get", "deploy"])
    for (const hit of results(query)) assert.ok(names.includes(hit), hit);
  assert.deepEqual(results(""), []);
  assert.deepEqual(results("   !!!   "), []);
  assert.deepEqual(results("qwertyzzzzzz"), []);
  assert.deepEqual(results("DePLoy"), results("deploy"));
});

test("audit one-character typo corpus preserves top-five recall", () => {
  let count = 0;
  let first = 0;
  for (const name of names) {
    const words = name.split(" ");
    const longest = words.reduce(
      (best, word, index) => (word.length > words[best].length ? index : best),
      0,
    );
    const word = words[longest];
    if (word.length < 6) continue;
    const middle = Math.floor(word.length / 2);
    words[longest] = word.slice(0, middle) + word.slice(middle + 1);
    const hits = results(words.join(" "));
    assert.ok(hits.includes(name), `${words.join(" ")}: ${hits.join(", ")}`);
    if (hits[0] === name) first++;
    count++;
  }
  assert.equal(count, 23);
  assert.ok(first >= 22, `${first}/${count} ranked first`);
});

test("the retained intent corpus preserves its top-five recall", () => {
  const cases = [
    ["publish website", "deploy"],
    ["deployment progress", "status"],
    ["runtime errors", "logs"],
    ["previous version", "versions rollback"],
    ["upload version", "versions create"],
    ["set secret", "env set"],
    ["list variables", "env list"],
    ["download environment", "env pull"],
    ["upload environment", "env push"],
    ["delete variable", "env unset"],
    ["read variable", "env get"],
    ["custom hostname", "domains add"],
    ["domain verification", "domains refresh"],
    ["remove hostname", "domains remove"],
    ["public audience", "access set"],
    ["current audience", "access show"],
    ["website traffic", "analytics summary"],
    ["authentication status", "auth whoami"],
    ["diagnose project", "doctor"],
    ["tab completion", "complete"],
  ];
  const hits = cases.filter(([query, expected]) => results(query).includes(expected));
  const first = cases.filter(([query, expected]) => results(query)[0] === expected);
  // Removing four retired targets cannot reduce the old lower bounds by more than four.
  assert.ok(hits.length >= 15, `${hits.length}/20 intent queries found their target`);
  assert.ok(first.length >= 9, `${first.length}/20 intent queries ranked first`);
});

// Builds the distributable single-file CLI with the bundled Rolldown.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "cli.mjs");

await build({
  input: path.join(root, "src", "index.ts"),
  platform: "node",
  external: ["rolldown"],
  output: {
    file: outfile,
    format: "esm",
  },
});

const body = fs.readFileSync(outfile, "utf8");
if (!body.startsWith("#!")) {
  fs.writeFileSync(outfile, "#!/usr/bin/env node\n" + body);
}
fs.chmodSync(outfile, 0o755);
console.error(`built ${path.relative(root, outfile)}`);

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: true,
    deps: {
      neverBundle: ["rolldown"],
    },
    banner: "#!/usr/bin/env node",
    outputOptions: {
      entryFileNames: "cli.mjs",
    },
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "docs/**", "aube-lock.yaml"],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

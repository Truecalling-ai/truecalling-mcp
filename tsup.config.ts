import { defineConfig } from "tsup";

// Bundle EVERY dependency into a single self-contained dist/index.js so a
// client only needs `git` + Node 20 — no `npm install` (which kills the
// corporate-TLS-on-esbuild failure) and no npx cache. The committed bundle is
// what clients run via run.mjs (git pull → node dist/index.js).
//
// ws ships optional native accelerators (bufferutil/utf-8-validate) loaded via
// dynamic require; keep them external so the bundle doesn't try to inline them
// — ws falls back to its pure-JS path when they're absent (the MCP never opens
// a realtime socket anyway).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  noExternal: [/.*/],
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire as __tcCreateRequire } from 'module'; const require = __tcCreateRequire(import.meta.url);",
  },
});

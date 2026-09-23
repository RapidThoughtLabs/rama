// AGENT_BROWSER_PLAN.md AB1 — bundles hook.ts and dom.ts to standalone minified IIFE strings.
// Run via `bun run build` (this package's package.json), or automatically by
// `src-tauri/build.rs`, which shells out to it before every `cargo build`/`cargo check` so the
// two `include_str!`'d files in webview.rs never go stale relative to this package's source.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
await mkdir(outDir, { recursive: true });

async function bundle(entry: string, outfile: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [srcDir + entry],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log.toString());
    throw new Error(`page-runtime: build failed for ${entry}`);
  }
  const [output] = result.outputs;
  const code = await output.text();
  await Bun.write(outDir + outfile, code);
  return code;
}

const hook = await bundle("hook.ts", "hook.iife.js");
const dom = await bundle("dom.ts", "dom.iife.js");

console.log(`[page-runtime] hook.iife.js: ${hook.length} bytes minified`);
console.log(`[page-runtime] dom.iife.js:  ${dom.length} bytes minified`);

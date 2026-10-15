import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // packages/ui and packages/protocol live outside this app's root (monorepo workspace
    // packages consumed as source, no build step in Phase 0) — allow Vite to serve them. Paths
    // resolve against this app's root, so ".." is apps/ only: modules in the import graph get
    // through regardless, but assets they reference (packages/ui's kit fonts) need packages/
    // listed explicitly or they 403.
    // HOME_REDESIGN_PLAN.md §5 — the design mockup is served from docs/Rama in dev so it can be
    // opened next to the app at /@fs/<repo>/docs/Rama/home-redesign.html for pixel diffs.
    fs: {
      allow: ["..", "../../packages", "../../docs/Rama"],
    },
  },
}));

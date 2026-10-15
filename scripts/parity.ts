#!/usr/bin/env bun
// Design-parity check for the Code tab (docs/CODE_REDESIGN_PLAN.md CR1).
//
// Renders the real app (fixture mode) and docs/Rama/home-redesign.html in the same headless
// Chrome, in the same state, at the same viewport, and writes a diff PNG plus a report. It is a
// layout-and-colour check, not a rasteriser comparison: both sides are drawn by one engine, so
// what shows up is CSS the app doesn't match, not font-smoothing noise. (The Home plan's
// WKWebView window capture is the complement for engine-specific issues.)
//
//   bun scripts/parity.ts                      flash × wakaba × 1440×900
//   bun scripts/parity.ts flash ccplan         chosen scenarios (ids in scripts/parity/scenarios.ts)
//   bun scripts/parity.ts all --theme wakaba,kanagawa,sumi,shu --size 1440x900,1100x800
//   bun scripts/parity.ts flash --app http://localhost:1420   dev server to read the app from
//   bun scripts/parity.ts flash --check        exit 1 unless every result passes
//   bun scripts/parity.ts flash --region sidebar     score one region (the rest is masked):
//                                              sidebar | topbar | ws-tabs | ws-band | ws | dock | chat | x,y,w,h
//
// Needs the app's dev server (`bun run --cwd apps/desktop dev`, port 1420) and Google Chrome.
// Pass criteria (shared with the Home plan §5): ≤ 0.5% of unmasked pixels differ and no 24×24
// block is mostly different. Masked: the traffic-light box (the mockup draws lights, the app has
// native ones), anything marked data-pixel-mask in either page, the mockup's sketched `.page`
// card (the app lays a native webview over its own, which headless Chrome never draws) and its
// `.term` text (xterm lays text on a cell grid and wraps by column; the mockup flows it).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, type Page } from "./parity/cdp";
import { COMPARE_FN } from "./parity/diffPage";
import { SCENARIOS, SIZES, THEMES, type Scenario } from "./parity/scenarios";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOCKUP = `file://${join(ROOT, "docs/Rama/home-redesign.html")}`;
const TRAFFIC_LIGHTS: [number, number, number, number] = [10, 14, 70, 24];
const PASS_PCT = 0.5;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const VALUE_FLAGS = new Set(["--theme", "--size", "--app", "--out", "--settle", "--region"]);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.has(all[i - 1] ?? ""));
const wanted = positional.length ? positional : ["flash"];
const scenarios: Scenario[] = wanted.includes("all") ? SCENARIOS : wanted.map((id) => SCENARIOS.find((s) => s.id === id) ?? (() => { throw new Error(`unknown scenario "${id}" (known: ${SCENARIOS.map((s) => s.id).join(", ")})`); })());
const themes = arg("theme", "wakaba") === "all" ? THEMES : arg("theme", "wakaba").split(",");
const sizes: [number, number][] = arg("size", "1440x900").split(",").map((s) => s.split("x").map(Number) as [number, number]);
const appOrigin = arg("app", "http://localhost:1420");
const outDir = resolve(ROOT, arg("out", "docs/Rama/parity"));
const settle = Number(arg("settle", "900"));
const region = arg("region", "");

type Rect = [number, number, number, number];
/** Region → rect, from the mockup's own layout (it is the target), at this viewport. */
function regionRect(name: string, [w, h]: [number, number], ws: Rect | null, dock: Rect | null, chat: Rect | null): Rect {
  const SB = 272;
  switch (name) {
    case "sidebar": return [0, 0, SB, h];
    case "topbar": return [SB, 0, w - SB, 52];
    case "ws": if (ws) return ws; break;
    case "ws-tabs": if (ws) return [ws[0], ws[1], ws[2], 50]; break;
    case "ws-band": if (ws) return [ws[0], ws[1] + 50, ws[2], 42]; break;
    case "dock": if (dock) return dock; break;
    case "chat": if (chat) return chat; break;
    default: {
      const n = name.split(",").map(Number);
      if (n.length === 4 && n.every(Number.isFinite)) return n as Rect;
    }
  }
  throw new Error(`bad --region "${name}" (sidebar | topbar | ws | ws-tabs | ws-band | dock | chat | x,y,w,h; ws needs the workspace open)`);
}
/** Everything outside `r`, as four mask rects. */
function outside(r: Rect, [w, h]: [number, number]): Rect[] {
  const [x, y, rw, rh] = r;
  return [[0, 0, w, y], [0, y + rh, w, h - y - rh], [0, y, x, rh], [x + rw, y, w - x - rw, rh]];
}

const FREEZE_CSS = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
const freezeStyle = `document.addEventListener("DOMContentLoaded",()=>{const s=document.createElement("style");s.textContent=${JSON.stringify(FREEZE_CSS)};document.head.appendChild(s)});`;
const freezeClock = `(()=>{const R=Date,n=Date.UTC(2026,9,5,18,30);class F extends R{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}}globalThis.Date=F})();`;

// setTimeout, not rAF: a page that isn't frontmost never gets animation frames in headless Chrome.
const ready = `document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,80)))`;
const maskRects = `[...document.querySelectorAll("[data-pixel-mask], .page, #stage .term")].map(e=>{const r=e.getBoundingClientRect();return [Math.floor(r.x),Math.floor(r.y),Math.ceil(r.width),Math.ceil(r.height)]})`;

async function shootMockup(page: Page, s: Scenario, theme: string, [w, h]: [number, number]) {
  await page.viewport(w, h);
  await page.initScript(freezeClock + freezeStyle + `try{localStorage.setItem("rama-home-theme",${JSON.stringify(theme)});localStorage.setItem("rama-home-scale","1");localStorage.setItem("rama-home-reading","serif")}catch{}`);
  await page.goto(MOCKUP);
  await page.eval(ready);
  await page.eval(s.landing ? `goCodeLanding(${JSON.stringify(s.landing)})` : `openCodeChat(${JSON.stringify(s.chat)})`);
  // The app opens a chat at the bottom (Home's D4 rule); the mockup opens at the top.
  if (s.scroll !== "top" && !s.landing) await page.eval(`(()=>{const e=document.querySelector("#codeScroller");if(e)e.scrollTop=e.scrollHeight})()`);
  if (s.goto) await page.eval(`goto(${JSON.stringify(s.goto)})`);
  if (s.mock) await page.eval(s.mock);
  await page.eval(ready);
  await Bun.sleep(settle);
  const ws = await page.eval<Rect | null>(`(()=>{const e=document.querySelector("#ws");if(!e||e.offsetParent===null)return null;const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})()`);
  const dock = await page.eval<Rect | null>(`(()=>{const e=document.querySelector("#codeDock");if(!e||e.offsetParent===null)return null;const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})()`);
  const chat = await page.eval<Rect | null>(`(()=>{const e=document.querySelector("#codeScroller");if(!e||e.offsetParent===null)return null;const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})()`);
  return { png: await page.png(), masks: await page.eval<Rect[]>(maskRects), ws, dock, chat };
}

async function shootApp(page: Page, s: Scenario, theme: string, [w, h]: [number, number]) {
  await page.viewport(w, h);
  await page.initScript(freezeStyle);
  // At ≤1100px the mockup's workspace is a sheet that starts closed; the app's would persist open.
  await page.goto(`${appOrigin}/fixture.html?fixture=code-${s.chat}&theme=${theme}&pane=${s.pane}${w <= 1100 ? "&open=0" : ""}`);
  await page.eval(ready);
  await Bun.sleep(settle);
  let gotoNote = "";
  if (s.goto) {
    const has = await page.eval<boolean>(`typeof window.__rama?.goto === "function"`);
    if (has) await page.eval(`window.__rama.goto(${JSON.stringify(s.goto)})`);
    else gotoNote = "app has no window.__rama.goto yet, so the pane's selection is its default";
  }
  if (s.app) await page.eval(s.app);
  await page.eval(ready);
  await Bun.sleep(settle);
  return { png: await page.png(), masks: await page.eval<[number, number, number, number][]>(maskRects), gotoNote };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const chrome = await launchChrome();
  const rows: string[] = [];
  const results: Record<string, unknown>[] = [];
  let failed = false;
  try {
    const differ = await chrome.page();

    for (const s of scenarios) for (const theme of themes) for (const size of sizes) {
      const tag = `${s.id}-${theme}-${size[0]}x${size[1]}${region ? `-${region.replace(/,/g, "_")}` : ""}`;
      const mp = await chrome.page();
      let mock;
      try {
        mock = await shootMockup(mp, s, theme, size);
      } finally {
        mp.close();
      }
      const ap = await chrome.page();
      let app;
      try {
        app = await shootApp(ap, s, theme, size);
      } finally {
        ap.close();
      }
      const masks = [TRAFFIC_LIGHTS, ...(s.mask ?? []), ...mock.masks, ...app.masks, ...(region ? outside(regionRect(region, size, mock.ws, mock.dock, mock.chat), size) : [])];
      const r = await differ.eval<{ width: number; height: number; sizeMismatch: boolean; diffPixels: number; comparedPixels: number; diffPct: number; badBlocks: number; png: string }>(
        `(${COMPARE_FN})(${JSON.stringify(mock.png)}, ${JSON.stringify(app.png)}, ${JSON.stringify(masks)}, 0.1)`,
      );
      writeFileSync(join(outDir, `${tag}-mock.png`), Buffer.from(mock.png, "base64"));
      writeFileSync(join(outDir, `${tag}-app.png`), Buffer.from(app.png, "base64"));
      writeFileSync(join(outDir, `${tag}-diff.png`), Buffer.from(r.png, "base64"));
      const pass = r.diffPct <= PASS_PCT && r.badBlocks === 0;
      if (!pass) failed = true;
      rows.push(`| ${tag} | ${r.diffPct.toFixed(2)}% | ${r.badBlocks} | ${pass ? "pass" : "FAIL"} | ${app.gotoNote} |`);
      results.push({ tag, diffPct: r.diffPct, badBlocks: r.badBlocks, pass, note: app.gotoNote });
      console.log(`${pass ? "✓" : "✗"} ${tag}  ${r.diffPct.toFixed(2)}% differ, ${r.badBlocks} bad blocks${app.gotoNote ? `  (${app.gotoNote})` : ""}`);
    }
  } finally {
    chrome.stop();
  }

  const md = `# Parity report\n\nApp: ${appOrigin} · pass = ≤ ${PASS_PCT}% differing and 0 bad 24×24 blocks\n\n| run | differ | bad blocks | result | note |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
  writeFileSync(join(outDir, "report.md"), md);
  writeFileSync(join(outDir, "report.json"), JSON.stringify(results, null, 2));
  console.log(`\nWrote ${outDir}/ (report.md, *-mock.png, *-app.png, *-diff.png)`);
  if (flag("check") && failed) process.exit(1);
}

await main();

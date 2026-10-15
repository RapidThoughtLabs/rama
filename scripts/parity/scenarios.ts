// What the parity run compares. Each scenario puts the real app (fixture mode, see
// apps/desktop/src/app/fixtures/install.ts) and the mockup (docs/Rama/home-redesign.html) into
// the same state. `mock` is driven by the mockup's own globals (openCodeChat, goto), so the
// mockup file is never edited.

export interface Scenario {
  id: string;
  /** Chat in CODE_CHATS (shared by both sides). */
  chat: string;
  /** CR8: a project id. Both sides land on that project's "New chat" screen instead of showing `chat`
   *  (the app still boots on `chat`, which should be one of the project's, then clicks the project's +). */
  landing?: "rama" | "demo";
  /** Workspace pane the app's panel is on at load (the mockup picks its own default per project). */
  pane: "changes" | "terminal" | "web" | "files";
  /** `pane:arg` handed to the mockup's goto() and, once CR3 lands, to the app's window.__rama.goto(). */
  goto?: string;
  /** Mockup-only extra JS, run after the chat opens. */
  mock?: string;
  /** App-only extra JS, run once the app has settled (the counterpart of `mock`). */
  app?: string;
  /** Where the mockup's transcript is scrolled: the app opens at the bottom, so that is the default. */
  scroll?: "top" | "bottom";
  /** Mask extra regions (x, y, w, h) on top of the standard ones. */
  mask?: [number, number, number, number][];
}

export const SCENARIOS: Scenario[] = [
  { id: "flash", chat: "flash", pane: "changes" },
  { id: "flash-terminal", chat: "flash", pane: "terminal", goto: "terminal:t2" },
  { id: "flash-files", chat: "flash", pane: "files", goto: "files:packages/ui/src/theme.tsx" },
  { id: "flash-web", chat: "flash", pane: "web", goto: "web:w1" },
  // Composer menus (CR5): each side clicks its own pill, then the menu is compared.
  { id: "menu-mode", chat: "flash", pane: "changes", mock: `document.querySelector("#codeDock [data-mode-menu]").click()`, app: `document.querySelector(".r-mode-pill").click()` },
  { id: "menu-model", chat: "flash", pane: "changes", mock: `document.querySelector("#codeDock [data-model]").click()`, app: `document.querySelector(".r-model-pill:not(.r-mode-pill)").click()` },
  // Transcript rows expanded (CR6): every act row open. Below ~1000px the flash chat's bash, web and review
  // rows differ from the mockup in words, not styling (plan §9.25), so only the top two screens are scored.
  { id: "rows-flash", chat: "flash", pane: "changes", scroll: "top", mock: `document.querySelectorAll("#codeTranscript [data-act]").forEach((b) => b.click())`, app: `(()=>{const sc=document.querySelector(".r-scroller");document.querySelectorAll(".r-transcript .r-act-btn").forEach((b) => b.click());sc.scrollTop=0})()` },
  { id: "rows-flash-700", chat: "flash", pane: "changes", scroll: "top", mock: `document.querySelectorAll("#codeTranscript [data-act]").forEach((b) => b.click());document.querySelector("#codeScroller").scrollTop=700`, app: `(async()=>{document.querySelectorAll(".r-transcript .r-act-btn").forEach((b) => b.click());await new Promise((r)=>setTimeout(r,250));document.querySelector(".r-scroller").scrollTop=700})()` },
  { id: "rows-about", chat: "about", pane: "changes", scroll: "top", mock: `document.querySelectorAll("#codeTranscript [data-act]").forEach((b) => b.click())`, app: `document.querySelectorAll(".r-transcript .r-act-btn").forEach((b) => b.click())` },
  // The Code landing (CR8): greeting, composer and "Recent in {project}", for both fixture projects.
  { id: "landing-rama", chat: "flash", landing: "rama", pane: "changes", app: `document.querySelector('button[aria-label^="New chat in"]').click()` },
  { id: "landing-demo", chat: "yt", landing: "demo", pane: "files", app: `document.querySelectorAll('button[aria-label^="New chat in"]')[1].click()` },
  { id: "ccplan", chat: "ccplan", pane: "changes" },
  { id: "about", chat: "about", pane: "changes" },
  { id: "hello", chat: "hello", pane: "changes" },
  { id: "yt", chat: "yt", pane: "files", goto: "web:w2" },
  { id: "pix", chat: "pix", pane: "files" },
  { id: "harness", chat: "harness", pane: "files" },
];

export const THEMES = ["wakaba", "kanagawa", "sumi", "shu"];
export const SIZES: [number, number][] = [
  [1440, 900],
  [1100, 800],
  [900, 800],
];

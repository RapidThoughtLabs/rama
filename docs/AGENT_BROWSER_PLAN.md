# Rama — Agent Browser Control Implementation Plan

Phases here are **AB0–AB7** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7 (`LOOP_MIGRATION_PLAN.md`),
loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`), workspace panes W0–W7
(`WORKSPACE_PANES_PLAN.md`), or symbol layer SL0–SL6 (`SYMBOL_LAYER_PLAN.md`).
Cite these as "AGENT_BROWSER_PLAN.md Phase AB2".

**What this document owns.** Everything between "an agent wants to know what a
page says, or wants to do something to it" and "a result came back small enough
to be worth putting in a context window." It finishes `MISSION_CONTROL_PLAN.md`
Phase M6, which shipped the `browser` tool read-only. It does not touch the Web
pane's human-facing surface — the rail, the omnibox, `useWebviewVisibility`,
window management — which belong to M5 and `WORKSPACE_PANES_PLAN.md`.

**The motivating use case is not browsing.** It is *the agent testing software
it just wrote, in a loop, with no human in it.* Every decision below is settled
by that sentence, and where "good general web agent" and "good self-test loop"
disagree, this document picks the second.

---

## 1. The framing: three claims that decide everything else

**1. Reading a page and acting on a page are different questions and want
different serializations.** "What does this page say" wants prose — headings and
paragraphs, no markup, no buttons. "What can I do here" wants a flat list of
actionable controls with handles, and almost no prose. Today's `read`
(`AgentWebBridge.tsx:62`) is `document.body.innerText.slice(0, 20000)`, which is
a mediocre answer to the first question and *no* answer to the second. Merging
them produces a blob that is expensive and bad at both. **They stay two ops.**

**2. The model must never be asked to invent a selector.** Every
selector-emitting design fails the same way: the model writes
`div.sc-x7f2a > button:nth-child(3)`, it is subtly wrong, the click lands
somewhere else, and the agent reports success. The fix is that *the page assigns
the handles*. A snapshot walks the DOM, stores real `Element` references in a
page-side map, and prints small integers. `click 12` is three tokens and cannot
be hallucinated into a different element — a wrong ref errors, it does not
mis-click. This is the single most important structural decision here.

**3. In a test loop, the diff is the product.** An agent running a 20-step
scenario does not need 20 full page dumps; 95% of each page is identical to the
last one. Actions return *what changed* plus *what the app logged*, and the full
snapshot is an explicit, occasional request. This is what makes a
self-improvement loop affordable rather than theoretically possible.

A corollary worth stating plainly, because it explains the bug report that
started this work: **the agent shelled out to `bash` to "click the first video"
because the tool has no click op.** `browser.ts:27-31` is
`open | read | snapshot | console`. The model was routing around a missing
capability, not misbehaving. Nothing in the prompt stack fixes that.

---

## 2. Why not Playwright, and why not a bundled Chromium

Considered and rejected, not deferred:

| Option | Why not |
|---|---|
| Bundle Playwright/Puppeteer + a Chromium download | ~200 MB, a second browser engine, a second cookie jar, and the automated browser is *not the window the user is watching* — which is the one property that makes this feel like Rama rather than a CI runner. The stated requirement was "the browser window should open showing the site the agent is going through." |
| Drive the existing webview over CDP | WebView2 (Windows) exposes CDP; WKWebView (macOS) does not. A design whose core mechanism exists on one platform is not a design. |
| An out-of-process headless browser as an optional backend | Two backends for one question, which `SYMBOL_LAYER_PLAN.md` §5 Decision 1 already rejected for `outline` and the reasoning carries. Revisit only if a real need for headless parallel runs appears. |

**So: everything runs as JavaScript injected into the visible Tauri child
webview.** That constraint is not a compromise — it is what gives the agent the
user's real session, real cookies, real extensions-free-but-real rendering, and
a window the user can watch and take over. It does impose §4's problems.

---

## 3. What is actually there today

Read before planning; the phases are built on these facts.

| finding | where |
|---|---|
| The tool's whole surface is `open`/`read`/`snapshot`/`console`. No action ops exist. | `engine/src/tools/browser.ts:27-31` |
| `snapshot` is an honest stub that always fails. | `browser.ts:34-45` |
| `read` is `document.body.innerText.slice(0, 20000)`, truncated head+tail to 8,000 chars for the model. | `AgentWebBridge.tsx:62`, `browser.ts:16`, `:72` |
| `console` reads a 200-entry ring buffer installed by an init script. There is no network log. | `AgentWebBridge.tsx:68`, `webview.rs:28-45` |
| Values come out of a page by navigating to `rama-eval://ok?token=…&value=encodeURIComponent(String(v))`, cancelled by `on_navigation`. | `webview.rs:59-86`, `:184-186` |
| `webview_eval` has a hard 8s timeout; the tool layer has 20s for `open`, 8s for everything else. | `webview.rs:192-199`, `browser.ts:14-15` |
| No custom URI-scheme protocol handler is registered anywhere in `src-tauri`. | verified — zero `register_*_uri_scheme_protocol` |
| The Tauri capability grant is scoped to `["main", "chat-*"]`, so `web-{page_id}` child webviews have **no IPC access at all**. | `capabilities/default.json` |
| Tauri is pinned to `=2.11.5` with the `unstable` feature, per M5's risk 1. | `src-tauri/Cargo.toml:23` |
| `open` "settles" by sleeping a flat 900ms, then reading `document.title`. | `AgentWebBridge.tsx:22-29` |
| Page metadata polls `webview_eval` up to 5 times over ~4s to catch a title. | `WebPaneContext.tsx:76-92` |
| `browser` gates on the `web` `PermissionTool`, which defaults to `allow`. Only `open` is gated. | `permissions.ts:20-21`, `db/settings.ts:12`, `browser.ts:100` |
| Page state is a module-level array, so it is **per-window**, not per-app. | `WebPaneContext.tsx:38` |
| Every open window's bridge answers the same broadcast; first response wins. | `browserBridge.ts:38-48` |
| The engine has no `test` script at the root; suites run as `bun test` per file. | `package.json:9-11`, 20 existing `*.test.ts` |

Two fixes landed just before this plan and are assumed by it: `createWebPage`/
`navigateWebPage` now rethrow native failures instead of swallowing them, and
`webview_create` resolves its window through `get_webview_window` like every
other call site.

---

## 4. The constraint that shapes the whole plan — and the spike that must confirm it

**The current value-return channel cannot carry a snapshot.** Results come back
as a URL query parameter (`webview.rs:184-186`). `encodeURIComponent` inflates
JSON by roughly 2–3× once braces, quotes and colons are percent-encoded, so a
20 KB accessibility tree becomes a ~50–60 KB URL. Platform URL handling is not
specified at that length and is not something to build a testing product on.
Every phase after AB1 produces payloads larger than today's `document.title`.

So **AB0 is a spike phase, and nothing below it is trustworthy until it runs.**
Unlike `SYMBOL_LAYER_PLAN.md` §4, the table here is *hypotheses*, not results:

| # | Hypothesis to verify in AB0 | If false |
|---|---|---|
| 1 | A custom async URI-scheme protocol (`rama-ipc://`) registered on the app can receive a `fetch(..., {method:"POST", body})` from a child webview, with the body intact and no size limit worth caring about. | Fall back to chunking over the existing `rama-eval://` channel: `value` becomes `seq`/`total`/`chunk`, reassembled in `EvalState`. Uglier, works, costs one extra phase. |
| 2 | The protocol handler can identify *which* webview sent the request (label or origin), so a response is attributed to the right page. | Embed the page id in the request path (`rama-ipc://eval/{token}`) — the token already disambiguates. |
| 3 | `initialization_script` in Tauri 2.11.5 can be applied to sub-frames, or there is a builder flag for it. | Cross-origin iframes stay invisible to the walker; AB6 documents it as a wall rather than solving it. |
| 4 | A custom scheme fetch from an `https://` page is not blocked by the page's own CSP. `tauri.conf.json` sets app CSP to `null`, but the *remote page's* CSP governs its own `connect-src`. | **This is the likeliest failure.** Fallback: keep `location.href = 'rama-eval://…'` as the signal (navigation is not `connect-src`-governed) and have Rust *pull* the payload back with a second `eval` that reads a global in slices. Slower, CSP-proof. |
| 5 | A ~100 KB injected bundle parses in single-digit milliseconds at document-start on a heavy page. | Split the bundle — see Decision 4. |

Hypothesis 4 is the one that can change the architecture, so **AB0 tests it
against a real CSP-hardened site (github.com, youtube.com), not just
localhost.** A channel that works on a Vite dev server and dies on every real
site is worse than no channel, because the failure only shows up in demos.

**AB0 results (2026-09-14).** Hypotheses 1–3 and 5 are confirmed by reading the
Tauri 2.11.5 source directly (`~/.cargo/registry/.../tauri-2.11.5/src/app.rs`),
which is a reliable way to answer "does this API exist and what does it hand
back" but not "does a real page's CSP block it" — that half of hypothesis 4
still needs a human running the built app, which this environment has no
display to do.

| # | Result | Evidence |
|---|---|---|
| 1 | **Confirmed.** `register_asynchronous_uri_scheme_protocol` takes `http::Request<Vec<u8>>` — the body is already there, no size limit in the API itself. | `app.rs:2198` |
| 2 | **Confirmed, and better than planned.** `UriSchemeContext::webview_label()` returns the calling webview's label directly — no need for the token-in-path fallback §4 proposed. | `app.rs:2469-2483` |
| 3 | **Confirmed.** `initialization_script_for_all_frames` exists as of 2.11.5, distinct from the main-frame-only `initialization_script` AB1 still uses for `rama-hook`. Whether it actually *reaches* a cross-origin iframe's `contentDocument` afterward is a same-origin read, not an injection question — still open, deferred to AB6. | `webview/mod.rs:886-933` |
| 4 | **Implemented, not verified.** `webview.rs`'s `webview_eval` now sends the value via `fetch('rama-ipc://ipc/{ok\|err}/{token}', {method:"POST", body})` first, and only falls back to the `rama-eval://` navigation if `fetch` itself is missing or its promise rejects (which is what a CSP `connect-src` block looks like from the page's side). `cargo check` and `tsc --noEmit` are clean on both sides of this channel. **What's not done:** an actual round trip against `github.com` / `youtube.com` on a running build — this environment has no GUI to drive a real webview in. The fallback exists specifically so that if this hypothesis is false in practice, `rama-eval://` keeps working with no code change needed; but the *primary* path's real-world behavior is still unverified. Before AB2 ships user-facing, run the 256 KB round-trip acceptance test below by hand. |
| 5 | **Accepted on general grounds, not measured.** A ~100 KB minified bundle parsing in single-digit ms is unremarkable for any modern JS engine; no fixture exists yet to measure it against (that's AB1's job). Flagged to revisit if AB1's bundle-size test ever shows otherwise. |

**AB0 build status:** `rama-ipc` is registered in `lib.rs`; `EvalState`'s existing oneshot map is reused (no new state needed — `handle_rama_ipc` resolves the same token-keyed map `on_navigation`'s `rama-eval://` handler does); `webview_eval` takes an optional `timeout_ms`. The elected-responder change (Decision 11) is also implemented: `browserBridge.ts` remembers the last window to answer per project, `tools/browser.ts` addresses the next request at it with a 2s fallback re-broadcast, and `AgentWebBridge.tsx` ignores requests addressed to a different window.

**Still owed before this phase is fully done:** the live 256 KB round-trip acceptance test against github.com, youtube.com, and a local Vite server, on macOS and Windows — someone with a display needs to run the built app and watch it happen. Everything downstream (AB1 onward) proceeds on the assumption that this passes or that the automatic `rama-eval://` fallback silently covers it either way; if the live test finds a *third* failure mode (not "CSP blocks it" but something else entirely), that needs to come back here before AB2 is trusted.

---

## 5. Decisions taken in this pass (2026-09-14)

| # | Decision | Consequence |
|---|---|---|
| 1 | **Handles are integers owned by the page, never selectors produced by the model.** A snapshot writes `window.__ramaRefs` and bumps a generation counter; ops take `ref`. | Clicks are exact or they error. Kills a whole class of silent wrong-element bugs. |
| 2 | **`snapshot` is renamed to mean the accessibility tree; screenshots become `screenshot`.** | Matches the term of art everywhere else. Free rename — today's `snapshot` is a stub that always fails, so no behaviour regresses. |
| 3 | **`read` and `snapshot` stay separate ops with separate serializers.** §1 claim 1. | Neither gets diluted to serve the other. |
| 4 | **The injected runtime splits in two: a tiny always-on hook, and a large on-demand DOM bundle.** `rama-hook` (console + network counters + mutation observer, <5 KB) ships as `initialization_script` on every page. `rama-dom` (a11y walker + Readability + Turndown) is injected on first use and guarded by a global. | Every page pays 5 KB; only pages the agent actually inspects pay 100 KB. |
| 5 | **Accessible names come from `dom-accessibility-api`, not a hand-rolled heuristic.** | The accname spec is genuinely hairy (`aria-labelledby` chains, `<label>` association, `alt`, `title` fallbacks). Getting names wrong makes every ref useless. |
| 6 | **Actions dispatch a full synthetic pointer sequence, not `el.click()`.** | Bare `.click()` misses `:hover`-revealed menus and pointer-event widgets. Native OS-level clicking is explicitly *not* built — it would steal the user's real cursor. |
| 7 | **Every action auto-appends console errors and failed requests since the previous action.** | For the stated use case this is the payload. A stack trace beats a DOM dump. |
| 8 | **Actions return a diff by default; full snapshots are requested explicitly.** | §1 claim 3. |
| 9 | **Action ops auto-allow on loopback origins and `ask` everywhere else.** Read ops keep today's `web` rule. | Zero friction for testing your own app; a prompt before an agent clicks "Delete account" on a real site. |
| 10 | **A stale ref is an error naming the generation gap, never a best-effort re-resolve.** | Absence of an element must keep meaning "it is not there". |
| 11 | **One window is elected responder per request**, replacing `browserBridge.ts:38-48`'s first-response-wins race. | Multi-window setups stop landing the agent's page in whichever window happened to be fastest. |

---

## 6. The wire format

### 6.1 `snapshot` — what the model sees

```
page 7f3a — "YouTube" — https://www.youtube.com/  (gen 4)

[1]  textbox  "Search"                                    (empty)
[2]  button   "Search"
[3]  link     "Home"                                       → /
[4]  link     "Rick Astley - Never Gonna Give You Up"      → /watch?v=dQw4w9WgXcQ
     text     "1.6B views · 16 years ago"
[5]  button   "More actions"
     … 47 similar list items omitted (snapshot depth:full to expand)
[6]  button   "Sign in"
```

Rules, each earning its place:

- **Only actionable nodes get a `[ref]`.** Links, buttons, inputs, selects,
  `[role]`s in the widget set, `[onclick]`, `[tabindex>=0]`, `contenteditable`.
  Everything else is unnumbered text.
- **Invisible is omitted**: `aria-hidden`, `display:none`, `visibility:hidden`,
  zero-area, `offsetParent === null`. This alone removes most of a modern app.
- **Wrapper chains collapse.** A `div > div > span "Save"` emits one line.
- **Text nodes truncate at 120 chars**; a node's text is its accessible name
  where it has one, its `innerText` otherwise.
- **Repeated structure dedupes.** Siblings with identical tag+role+class
  signature collapse after the third, with a count. This is where the biggest
  wins on real sites come from.
- **Form state is inline** — `(empty)`, `(checked)`, `(value: "hello")`,
  `(disabled)` — because "did my click work" is usually a state question.
- **Two depths**: `outline` (default; interactive + headings only) and `full`.
  The default is what a test loop wants.

### 6.2 Action results — the diff

```
clicked [4] "Rick Astley - Never Gonna Give You Up"
settled in 1.2s (network idle, dom stable)  ·  gen 4 → 5

+ [12] button  "Pause"
+ [13] slider  "Seek"          (value: 0)
~ heading      "YouTube" → "Rick Astley - Never Gonna Give You Up - YouTube"
- [6]  button  "Sign in"

console: 1 error
  TypeError: Cannot read properties of undefined (reading 'id')
    at PlayerControls (player.tsx:42:18)
network: 1 failed
  GET /api/recommendations → 500 (142ms)
```

That block is the whole loop: what I did, whether the page settled, what
changed, what broke. Budget target: **under 300 tokens for a typical step.**

### 6.3 `read` — comprehension

Readability → Turndown → markdown, with the existing head+tail truncation.
Falls back to today's `innerText` when Readability declines the page (it is
tuned for articles and will refuse an app shell) — and says which one it used,
so the model knows whether it is looking at a curated extract or a raw dump.

---

## 7. Phases

### AB0 — the transport, and the spike that validates it

Answer §4's five hypotheses before writing anything else, in this order: 4, 1,
2, 3, 5. Write the results into §4 as a *verified* table, the way
`SYMBOL_LAYER_PLAN.md` §4 records its spike, and amend the phases if a fallback
is triggered.

Then build the winning channel in `webview.rs`:

- Register an async URI-scheme protocol (`rama-ipc`) in `lib.rs`'s builder.
- `EvalState` gains a payload map alongside its oneshot senders; the handler
  resolves `token → payload` and returns `204`.
- `webview_eval` keeps its signature and its 8s default, but gains an explicit
  `timeout_ms` argument — AB5's settle-and-snapshot will legitimately need 30s,
  and the current hard-coded constant would make that unreachable.
- Keep `rama-eval://` as the small-value path. Do not delete it: it is
  navigation-based, so it survives a CSP that blocks `connect-src`, and §4
  hypothesis 4 may make it the primary channel again.

Also in AB0, because it is transport-adjacent and cheap: replace
`browserBridge.ts`'s first-response-wins with an elected responder. The engine
names a window in the `browser.request` envelope (last window to answer for this
project, else any); other windows ignore it; a 2s no-answer falls back to
broadcast. This removes the race and Risk 3 below in one change.

**Acceptance:** a round trip of a 256 KB string out of a page on
`https://github.com`, `https://www.youtube.com`, and a local Vite server, on
macOS and Windows, under 200 ms. If any of those six cells fails, the fallback
for that hypothesis ships instead — and the failure is written down.

### AB1 — the page runtime

New workspace package `packages/page-runtime/`, built with esbuild to two IIFE
strings consumed by Rust and by the bridge.

`rama-hook` (init script, replaces `webview.rs:28-45`'s `CONSOLE_HOOK_SCRIPT`):

- The existing console ring buffer, plus `window.onerror` and
  `unhandledrejection` — an uncaught exception never reaches `console.error` and
  is exactly the failure a test loop must not miss.
- `fetch`/`XMLHttpRequest` wrappers keeping an in-flight count and a 100-entry
  ring of `{method, url, status, ms}`. Failures (network error, `>=400`) are
  flagged.
- A `MutationObserver` recording `lastMutationAt`.
- A monotonic `seq` stamped on every console/network entry, so AB5 can ask "what
  happened since seq N" instead of re-sending the whole buffer.
- Hard rule: **no exceptions escape into the host page.** Everything in
  `try/catch`, no globals beyond the `__rama*` namespace, no prototype changes
  beyond the two wrappers. This code runs on every page the user opens too.

`rama-dom` (lazy): `dom-accessibility-api`, `@mozilla/readability`, `turndown`,
plus AB2's walker.

**Acceptance:** bundle sizes asserted in a test (`rama-hook` < 5 KB,
`rama-dom` < 120 KB, both minified); a fixture page that throws on load reports
the error through `__ramaConsole`; a page that never loads the DOM bundle is
byte-identical in behaviour to one without Rama.

**Shipped (2026-09-14).** `packages/page-runtime/` exists with `src/hook.ts`
(2.7 KB minified) and `src/dom.ts` (17.7 KB minified, well under both budgets —
`@mozilla/readability`/`turndown` are dependencies of the package but not yet
imported by `dom.ts`, since wiring them in is AB3's job, not AB1's; importing
them unused now would just be dead-code-eliminated and wouldn't tell this
phase's size test anything true about AB3's eventual cost). `hook.ts` is built
via `bun run build` (Bun's own bundler, not esbuild directly — same minified-
IIFE output the plan asked for) and consumed by `webview.rs` through
`include_str!`; `src-tauri/build.rs` now shells out to that build before every
`cargo build`/`cargo check`, gated by `cargo:rerun-if-changed` on
`page-runtime/src/` so an unrelated Rust-only change doesn't pay a `bun`
invocation. `test/hook.test.ts` runs the *built* IIFE against a `happy-dom`
`Window` (not the pre-bundle TS) and covers the acceptance list above, plus
fetch/XHR wrapping and mutation tracking the plan's acceptance line didn't
spell out but AB5 will need. All 8 tests pass.

### AB2 — `snapshot`: the ref tree

`packages/page-runtime/src/walk.ts` — a pure function over a `Document`,
unit-testable in `bun test` with `happy-dom`, no Tauri anywhere.

- Traverse light DOM, **open shadow roots** (`el.shadowRoot`), and
  **same-origin iframes** (`iframe.contentDocument`). Closed shadow roots are
  invisible to any script and are a documented blind spot, not a bug.
- Assign refs into `window.__ramaRefs` (a `Map<number, Element>`), bump
  `window.__ramaGen`, and clear both on `pagehide`/`popstate`/navigation.
- Serialize per §6.1.

Protocol: `BrowserOp` gains `"snapshot"` with real semantics plus
`depth?: "outline" | "full"`, and `BrowserResponseBody` gains `snapshot`, `gen`,
and `refCount`.

**Acceptance:** golden-file tests over three saved fixture pages — a Vite React
app, a docs site, and a heavy feed — asserting both exact output and a **token
budget**: outline depth under 1,500 tokens for all three. A fixture whose output
grows past budget fails the build; that is the whole point of the phase.

**Shipped (2026-09-14).** `packages/page-runtime/src/walk.ts` implements the
walker exactly as scoped — pure over a `Document`, no `window.__rama*` reads or
writes, tested with `happy-dom` and zero Tauri. `dom.ts` is the thin wrapper
that owns `window.__ramaRefs`/`__ramaGen` and calls it. Same-origin iframes and
open shadow roots are both handled per spec; cross-origin iframes emit the
`[iframe] cross-origin: … (not inspectable)` line AB6 was going to add — it
fell out of the walker's structure for free rather than needing its own phase.
Protocol changes landed as specified (`BrowserRequest.depth`,
`BrowserResponseBody.snapshot`/`gen`/`refCount`), and `browser.ts`'s `snapshot`
op is wired end to end — no more stub — with the tool description rewritten to
match Decision 2's rename. Three synthetic fixtures (`test/fixtures/*.html` —
this environment has no network access to scrape a real Vite app, docs site,
or feed, so they're hand-built stand-ins structurally shaped like the real
thing) back 13 tests in `test/walk.test.ts`, using `bun:test`'s built-in
`toMatchSnapshot` as the golden-file mechanism (no custom harness needed) plus
an explicit token-budget assertion (chars/4 approximation, documented in the
test file — no tokenizer is a dependency anywhere else in this repo either).

**Two real bugs found by writing these tests, not by inspection** — worth
recording since they're exactly the kind of thing "the diff is the product"
is supposed to catch once this is self-hosting: the first golden output had
`searchbox""` with no separating space (a `padEnd(9)` that exactly fit
"searchbox" with nothing left over — fixed by making the space between role
and name literal rather than relying on padding to produce it), and the
original "collapse any run of 4+ identical siblings" rule silently deleted a
genuinely distinct 4th nav link from the docs-site fixture (`API Reference`) —
raised to "collapse only runs of 7+" (`MIN_RUN_TO_DEDUPE = 6`, keeping the
first 3), which still collapses the 50-item feed fixture hard while leaving
ordinary short navs fully visible. Full write-up of why in `walk.ts`'s own
comment on the constant.

**Native wiring:** `webview.rs` gained a `webview_snapshot` command —
`include_str!`s `dist/dom.iife.js` and prepends it to a call to
`window.__ramaSnapshot(depth)` on every invocation rather than tracking
"already injected" state on the Rust side (cheap and correct: `dom.ts` guards
its own install, so re-sending it to a page that already has it is a same-tick
no-op, and a page that navigated since the last snapshot always gets it
reinstalled with no extra bookkeeping). `__ramaSnapshot` returns JSON
(`{text, gen, refCount}`) rather than the raw §6.1 text so the native layer
doesn't need a second eval round trip to learn the fields the protocol wants
separately.

### AB3 — `read` v2 and `console` v2

Small phase, immediate value, no new concepts.

- `read` routes through Readability→Turndown per §6.3, with the `innerText`
  fallback and an explicit note about which path ran.
- `console` gains `since?: number` (the AB1 seq) and returns network failures
  alongside console entries. Errors and warnings sort before logs when
  truncating — a 200-entry buffer full of debug noise must not push out the one
  `TypeError`.

**Acceptance:** a fixture article extracts to markdown at <40% the token count
of its `innerText`; a fixture app-shell page falls back and says so.

**Shipped (2026-09-15).** `packages/page-runtime/src/read.ts` implements §6.3 exactly:
`Readability` runs against `doc.cloneNode(true)` (the library's own documented
usage — never the live document), `Turndown` converts the result to markdown,
and anything Readability declines or returns under `MIN_ARTICLE_CHARS` (200 —
an app shell can "succeed" with a three-word extraction that isn't an article)
falls back to `innerText`, with a `fallbackReason` string carried alongside so
the caller — and the tool response, which now appends `(extracted as article)`
or `(full page text — <reason>)` to `read`'s summary line — never has to guess
which path ran. `test/fixtures/article.html` is a new fixture built specifically
for this phase's acceptance line: a real multi-paragraph article buried in the
chrome a real content site actually ships (cookie banner, nav, sidebar with a
newsletter pitch and seven "popular posts", ad slots, share buttons, a related-
posts list, and a four-column footer) — extraction comes in at **37.2%** of the
raw `innerText` token count, under the 40% line with real margin, not by
accident: the first draft of this fixture had too little chrome and extracted
at 53.7%, so it was expanded until the ratio actually meant something instead
of just returning "yes" on an easy case. 5 tests in `test/read.test.ts` cover
the budget line, that the extracted text is the article's own prose and not
the chrome, the app-shell fallback (reusing AB2's existing fixture), a docs
page, and an empty document (fallback, not a throw).

`console`'s v2 lives in `hook.ts` as `window.__ramaConsoleSince(since, limit)`
— always-on, not lazy, since it only touches AB1's existing console/network
ring buffers. Merges console entries with *failed* network requests (`!e.ok`),
filters to `seq > since`, and — only when the combined set exceeds `limit` —
selects errors/warnings before plain logs in a stable sort, then re-sorts the
selected subset back into chronological order for output. `tools/browser.ts`'s
`console` op gained a `since` input field and returns `lastSeq` (the newest
seq seen, so the tool's own summary line can tell the model to pass
`since: <lastSeq>` next time) — this doubles as the seq bookkeeping AB5's
`settle()` will need for "what happened since this action started". 5 new
tests in `test/hook.test.ts` cover `since` filtering, the default (since 0),
network-failure merging (successes excluded), and both the severity-first
truncation and its chronological re-sort.

Both wired into `dom.ts` (`window.__ramaRead`) and a native command each
(`webview_read`, mirroring `webview_snapshot`'s "always cheaply re-send
DOM_SCRIPT" shape) through to `AgentWebBridge.tsx` and `browser.ts`. `dom.ts`'s
bundle grew from AB2's 17.7 KB to **67.5 KB** now that Readability and Turndown
are actually imported (not just declared dependencies) — still well inside the
120 KB budget. A new `packages/page-runtime/tsconfig.json` was added this phase
too (the package had none before — `bun test`/`bun build` type-strip but don't
type-check), which caught one real pre-existing issue: `hook.ts`'s `fetch`
wrapper didn't structurally satisfy `typeof fetch` under a newer `lib.dom.d.ts`
(a `preconnect` static the wrapper doesn't need to implement) — fixed with a
one-line cast and a comment, not a behaviour change.

### AB4 — actions

`BrowserOp` gains `click`, `type`, `press`, `scroll`. Four ops, deliberately —
`hover`, `select`, `drag`, `upload` are not built until something real needs
them, because every op is schema tokens on every request in every session.

```ts
z.object({ op: z.literal("click"),  ref: z.number(), id: z.string().optional() }),
z.object({ op: z.literal("type"),   ref: z.number(), text: z.string(), submit: z.boolean().optional(), id: z.string().optional() }),
z.object({ op: z.literal("press"),  key: z.string(), id: z.string().optional() }),
z.object({ op: z.literal("scroll"), to: z.union([z.literal("top"), z.literal("bottom"), z.number()]), id: z.string().optional() }),
```

Implementation notes:

- Resolve `ref` against `__ramaRefs` at the current generation. Mismatch →
  `ref 12 is from snapshot gen 3; the page is at gen 5 — take a new snapshot`.
  Element detached → `ref 12 no longer in the document`. Never re-resolve.
- `scrollIntoView({block:"center"})`, then dispatch
  `pointerover → pointerdown → mousedown → focus → pointerup → mouseup → click`
  with real client coordinates from `getBoundingClientRect()`.
- `type` sets value through the native property setter (React's controlled
  inputs ignore a plain `el.value =` because they track the descriptor), then
  fires `input` and `change` with `bubbles: true`. `submit: true` appends
  `Enter`. This detail is the difference between working and not working on
  every React app, which is most of what this feature will be pointed at.
- An action on an element covered by another element (`elementFromPoint` at the
  centre returns a non-descendant) returns a warning naming the blocker rather
  than clicking through it — an invisible modal overlay swallowing clicks is a
  real bug worth surfacing, not routing around.

**Permissions, in this phase.** `permissionToolFor` (`permissions.ts:12-25`)
learns that action ops are not `web`-read: loopback origins (`localhost`,
`127.0.0.1`, `[::1]`, `*.localhost`) auto-allow; everything else resolves `ask`
regardless of the `web` rule, unless a project explicitly sets otherwise. The
gate's `input` already reaches the approval UI, so the prompt can say
*click "Delete account" on github.com* rather than *browser*.

**Acceptance:** against a local fixture app — click a React button and observe
state change; type into a controlled input and assert the component's state, not
just the DOM value; click a covered element and get the warning; use a stale ref
and get the generation error.

**Shipped (2026-09-15).** `packages/page-runtime/src/actions.ts` implements all
four ops exactly as scoped: `dispatchClick` runs the full
`pointerover → pointerdown → mousedown → focus → pointerup → mouseup → click`
sequence at the element's real `getBoundingClientRect()` center (after
`scrollIntoView({block:"center"})`), checks `elementFromPoint` at that center
first and reports a `warning` naming the blocking element instead of clicking
through it (an ancestor or descendant of the target is never treated as
"covering" it — only a genuinely unrelated element is); `dispatchType` goes
through the native `HTMLInputElement`/`HTMLTextAreaElement` prototype's `value`
setter specifically because React (and every other controlled-input framework)
shadows the instance property and only reacts to the prototype setter, then
fires `input`/`change` with `bubbles:true`, and `submit:true` additionally
dispatches an Enter keydown/keyup and calls `form.requestSubmit()`;
`dispatchPress` and `dispatchScroll` are the two ops that don't take a `ref` —
press dispatches to `document.activeElement`, scroll resolves `"top"`/
`"bottom"`/a number against `scrollingElement`.

Ref resolution and Decision 10's stale-ref errors live in `dom.ts`, not
`actions.ts` — `window.__ramaAction(opJson)` looks the ref up in the *current*
`__ramaRefs`, and a new `refGenOf: Map<number, number>` (populated alongside
`__ramaRefs` on every `__ramaSnapshot` call, deliberately never cleared by
`clearRefs`) lets a miss say *why*: `ref 12 is from snapshot gen 3; the page
is at gen 5 — take a new snapshot` when the ref was assigned by an earlier
snapshot, or `ref 12 was never assigned by a snapshot` when it never existed
at all — distinct from `ref 12 no longer in the document`, which means the ref
resolved but the element has since been removed. All three are real, distinct
error strings, not one generic "invalid ref" message, and no code path ever
re-resolves a ref against a different element than the one it was minted for.

**Permissions**, exactly as scoped: `permissions.ts` gained
`resolveBrowserActionRule(projectId, origin)` — an explicit project or global
`browser_action` rule wins if set (protocol gained that `PermissionTool`
value, deliberately absent from `DEFAULT_PERMISSIONS` so its *absence* is what
triggers the origin-based default, not a static "ask"), otherwise loopback
origins (`localhost`, `127.0.0.1`, `::1`, `*.localhost`) auto-allow and
everything else asks. `gate()` gained an optional `rule` field on its options
that bypasses the normal `permissionToolFor`/`resolvePermissionRule` lookup
when supplied, since the action-ops decision isn't a static per-tool setting.
The one piece of real plumbing this needed: the engine has no page registry,
so `browserBridge.ts` now tracks `lastPageId` (per project) and `pageOrigin`
(per page) purely from response traffic it already sees (every response now
carries `url`, not just `open`/`read`'s) — no new round trip, and it doubles
as how `tools/browser.ts` resolves which page an action with no explicit `id`
targets *before* broadcasting, so the page the permission gate checked is
provably the same page the action runs on, not a second independent guess by
the frontend. This is a real approximation of per-window page state (Risk 3),
not a fix for it — it's good enough because an action always follows a
`snapshot` or `open` for the same page in practice.

Actions don't return a diff yet — that's explicitly AB5's job — so a
successful action's tool response says what ran and tells the model to take a
new `snapshot` to see what changed, rather than claiming a capability this
phase doesn't have.

11 new tests in `test/actions.test.ts` cover the dispatch functions directly
(full pointer sequence fires, zero-size element is rejected, covered-element
warning fires and the click doesn't happen, a descendant/ancestor at the
click point isn't treated as covering, controlled-input `type` + submit +
contenteditable + non-editable rejection, press, scroll to all three `to`
forms) against `happy-dom`, which has no real layout engine — `getBoundingClientRect`
and `elementFromPoint` are monkey-patched per test on the specific elements
under test, the same way a test double for anything that doesn't paint pixels
has to be. 9 more in `test/dom.test.ts` cover the wiring on top: ref
assignment/gen bumping, the bundle-size budget, both stale-ref error shapes
(gen-mismatch vs. never-assigned) with real seeded scenarios (not just
asserting the string format), the "detached without a new snapshot" case, and
that click/type genuinely dispatch through to a live element once a ref
resolves cleanly. 4 more in `permissions.test.ts` cover
`isLoopbackOrigin`/`decideBrowserActionRule`'s pure decision logic directly —
the DB-backed `resolveBrowserActionRule` wrapper isn't unit-tested, since this
repo has no existing pattern for standing up a fixture project/settings store
in a test and the pure logic is the part actually worth pinning down.

**Not done, and explicitly out of scope for this phase:** the acceptance
list's own fixture-app run (click a real React button, assert real component
state) needs a running desktop app with a display — this environment can build
and unit-test every piece up to the native boundary, but "does this actually
work against a real webview" is the same live-verification gap AB0 already
flagged for the transport itself, now inherited by everything built on top of
it. Wiring a `PERMISSION_TOOLS` row into `SettingsModal.tsx` for
`browser_action` (so a user could see/change the loopback-vs-ask default from
the UI, not just via direct settings-store access) was deliberately not done
either — nothing in this phase's acceptance criteria asked for it, and it's a
clean, independent follow-up whenever the UI work is prioritized.

### AB5 — settle and diff

The determinism layer, and the phase that decides whether loops are flaky.

- `settle(timeoutMs)`: resolve when in-flight `fetch`/XHR is zero **and**
  `now - lastMutationAt > 300ms`, polling at 100ms, capped (default 5s, arg up
  to 30s). Returns *why* it returned — `network idle, dom stable` or
  `timed out after 5s (2 requests still in flight)`. A timeout is not an error;
  it is information the model needs.
- Replace `AgentWebBridge.tsx:22-29`'s flat 900ms sleep with `settle`. Same for
  `WebPaneContext.tsx:76-92`'s five-poll title loop.
- `diffSnapshot(prev, next)` in the page runtime, keyed on a stable node
  signature (role + accessible name + DOM path), emitting §6.2's `+`/`-`/`~`.
- Every action op runs `settle` then returns the diff plus console/network
  deltas since its own start seq. `full: true` opts into the whole snapshot.

**Acceptance:** a fixture app with a 400ms delayed fetch-then-render; assert the
diff contains the rendered content — i.e. the exact "clicked, read too early,
saw the old page" flake, in a regression test. Plus: a 10-step scripted run
whose total returned tokens are asserted under a budget.

**Shipped (2026-09-15).** `settle()` lives in `hook.ts`, not `dom.ts` —
`window.__ramaSettle(timeoutMs)`, deliberately placed next to the
`__ramaInFlight`/`__ramaLastMutationAt` state it reads (both already tracked
by AB1's always-on hook) so every caller that just wants to wait for a page to
go quiet (`open`, `reload`/`goBack`/`goForward`'s `refreshPageMeta`, and the
action ops) gets it without AB2's much heavier a11y-walker bundle being
injected first. It polls every 100ms, resolves once in-flight is zero *and*
the DOM has been quiet for >300ms, and gives up at `timeoutMs` (default 5s,
clamped to a 30s ceiling) — the returned reason is always a real sentence
(`"network idle, dom stable"` or `"timed out after 5s (2 requests still in
flight)"`), not a bare boolean, exactly as scoped. `AgentWebBridge.tsx`'s
`settleAndDescribe` and `WebPaneContext.tsx`'s `refreshPageMeta` both now call
it once instead of sleeping a fixed amount or polling title/url up to five
times — one settle wait, one read, in both places.

`diffSnapshot(prev, next)` (`packages/page-runtime/src/diff.ts`) is pure over
two `WalkNode[]` arrays, matching nodes across snapshots by `role + DOM path`
(a `TAG:childIndex` chain from the element up to `<body>`) rather than `ref`,
since refs are reassigned every snapshot (Decision 10) and can't be compared
across generations. A matched node whose name or state differs becomes a `~`
line instead of a spurious remove+add pair — exactly §6.2's own
`"YouTube" → "Rick Astley..."` example. Only `actionable`/`heading` kinds
participate (the only walk.ts node kinds with a stable identity worth
tracking); output is capped at 40 lines with a trailing `"N more changes
omitted"` note, the same budget-defense walk.ts's own sibling-dedupe applies.

`dom.ts`'s `__ramaAction` is now `async` (it has to be, to `await
window.__ramaSettle()`) and, on a *successful* dispatch only, records a
`startSeq` via `__ramaNextSeq()` before dispatching, awaits settle, re-walks
the page through a `takeSnapshot()` helper shared with `__ramaSnapshot` (so
ref assignment/gen-bumping/the `lastSnapshotNodes` cache only ever happen in
one place), and returns either `diffSnapshot(lastSnapshotNodes, newNodes)` or,
with `full: true`, the whole new snapshot text — plus the console/network
delta since `startSeq` via the existing `__ramaConsoleSince`. A *blocked or
failed* dispatch (stale ref, covered element, ...) returns immediately with no
settle/diff attempt, since nothing happened for there to be a diff of.
Native side: `webview.rs`'s `webview_eval` JS wrapper now detects a returned
thenable (`typeof __v.then === 'function'`) and awaits it before sending the
result back, rather than stringifying `[object Promise]` — a small,
backward-compatible change every synchronous `expr` before this phase is
unaffected by.

The wire protocol threads a `full?: boolean` through `BrowserRequest` and
`ActionOp`, and `BrowserResponseBody` gained `settleReason`, `settleMs`,
`genFrom` (`gen` already existed and now doubles as `genTo`), `diff`, and
`full` — reusing `snapshot`/`gen`/`refCount`/`consoleLogs` for the `full:true`
case instead of adding parallel fields. `tools/browser.ts` assembles the
final §6.2 block via a new pure, exported `formatActionOutcome(verb, res)` —
pulled out specifically so the token-budget acceptance criterion could be
unit-tested without a live webview. A timeout reason (starting with `"timed
out"`) is rendered as `settled: <reason>` rather than `settled in Xs
(<reason>)`, since the reason string already states its own duration and the
two would otherwise repeat the same number.

Tests: `hook.test.ts` gained 3 covering `__ramaSettle` (resolves cleanly, waits
out an in-flight fetch before resolving, times out and says why without
throwing). `diff.test.ts` is new — 8 tests over real `walkDocument()` output
(not hand-built nodes): no-op diff, additions, removals, a heading name change
as `~`, a checkbox state change as `~`, diffing against an empty baseline
(everything reported as added), the 40-line cap with its omission note, and
that `text`/`omitted` nodes never appear even when they change. `dom.test.ts`
gained an "AB5" block layered on top of the AB4 tests it already had — the
`installDom()` helper now loads `hook.iife.js` *and* `dom.iife.js` onto the
same window, in the same order webview.rs uses them for real, so
`__ramaSettle` is genuinely present rather than needing its own test-only
fallback path. Six new tests there cover: click-settles-with-an-empty-diff,
press/scroll also settle+diff despite not needing a `ref`, a blocked click
skips settle entirely (no `settleReason` on failure), a click that adds
elements reports `+` lines, `full: true` returns a snapshot instead of a
diff, and — the acceptance criterion's own regression test — a click whose
handler kicks off a 400ms-delayed `fetch` before rendering, asserting the
returned diff contains the *rendered* content rather than whatever was on the
page the instant the click returned. `engine/src/tools/browser.test.ts` is
new: 6 tests pin `formatActionOutcome`'s exact shape (no-change / diff shown /
timeout wording / full-snapshot / console-delta / no-settle-line-on-failure),
plus the 10-step scripted-run acceptance test itself — ten varied, realistic
action results (mixed click/type/press/scroll, a couple of no-op steps, one
timeout, one with a console entry) formatted through the real function and
measured at the same chars/4 approximation `walk.test.ts` already uses,
averaging well under the 300-token/step budget. 238/238 engine tests and
65/65 page-runtime tests pass; `tsc --noEmit` is clean in `engine`,
`packages/page-runtime`, and `apps/desktop` (for every file this phase
touched — unrelated pre-existing errors in `apps/desktop/src/app/chat/`, from
untracked work elsewhere in the tree, are not this phase's concern); `cargo
check --offline` is clean.

**Not done, and explicitly out of scope for this phase:** a live-webview
acceptance run of the exact same 400ms-delayed-fetch scenario against a real
child webview (as opposed to the happy-dom regression test, which exercises
the identical code path against a simulated DOM) — same live-verification gap
every phase since AB0 has flagged, needing a running desktop app with a
display. AB6's `screenshot` and cross-origin-iframe work, and AB7's scenario
replay, are both explicitly gated on this phase and untouched, per the plan's
own "do not start AB7 until AB5's diff is real" rule.

### AB6 — the two escape hatches

Both are "when the tree is not enough", and both are genuinely optional.

- **`screenshot`** — finally real. Capture the child webview to PNG, land it as
  an `artifact.created` with `kind: "file"` (the type already exists,
  `protocol/src/index.ts:6`), and return a vision content part for models that
  take one, degrading to "not supported by this model" exactly as M6 specified.
  Needed for canvas/WebGL/visual-regression work, where a11y trees say nothing.
- **Cross-origin iframes** — resolved by §4 hypothesis 3. If all-frames init
  scripts are available, each frame self-registers and refs namespace as
  `2:14`. If not, the walker emits
  `[iframe] cross-origin: https://checkout.stripe.com (not inspectable)` so the
  model knows there is something there rather than seeing nothing — absence must
  never silently mean emptiness.

### AB7 — scenarios: write once with a model, replay forever without one

The payoff phase, and the reason the rest is worth building.

A scenario is a file in the project (`.rama/scenarios/*.json`), written by the
agent, containing steps (`open`/`click`/`type`/`press`/`settle`) and assertions
(`text_present`, `ref_present`, `no_console_errors`, `no_failed_requests`).
`browser scenario record|run|list` drives it. `run` replays with **no model in
the loop at all**: steps resolve refs *by signature*, not by number, since refs
are per-snapshot.

On success it returns one line. On failure it returns the failing step, the
diff, the console/network delta, and a screenshot if AB6 shipped — a bug report
the agent can act on, costing model tokens only when something is actually
broken.

**This is what "self-improvement loop" has to mean to be affordable.** An agent
that re-derives a whole test run through an LLM on every commit is a demo. An
agent that writes the test once and re-runs it for free is a workflow. Do not
start AB7 until AB5's diff is real, because a replayer built on flaky settling
produces failures nobody trusts, and an untrusted test suite is worse than none.

---

## 8. Order and dependencies

```
AB0 ──▶ AB1 ──▶ AB2 ──▶ AB4 ──▶ AB5 ──▶ AB7
                 └──▶ AB3          └──▶ AB6 (optional)
```

**AB0–AB2 is the first shippable unit**: after it, an agent can see what is on a
page instead of guessing, which already fixes the reported bug's root cause.
**AB0–AB5 is the real feature.** AB3 is an independent quality-of-life win that
can land any time after AB1. AB6 is optional forever. AB7 is the one that
changes what the product is.

---

## 9. Risk register

1. **Page CSP blocks the transport (§4 hypothesis 4).** The highest-probability
   failure in this plan and the only one that can force a redesign. Mitigated by
   testing against hardened real sites in AB0, before any dependent code exists,
   and by keeping the navigation-based channel alive as a fallback.

2. **`unstable` Tauri API churn.** Inherited from `MISSION_CONTROL_PLAN.md` §9
   Risk 1 and now larger: a custom protocol handler plus possible sub-frame
   script injection. Same mitigation, applied harder — Tauri stays pinned at
   `=2.11.5`, and every new native call lives in `webview.rs`. A bump is a
   deliberate, tested change.

3. **Per-window page state (`WebPaneContext.tsx:38`).** Two windows have two
   independent `pages` arrays, so "the agent's most recent page" is ambiguous
   and a `browser read` can land in a window the user is not looking at. AB0's
   elected responder makes this deterministic; it does not *unify* the state.
   Full unification means moving page ownership into Rust or the engine, which
   is a bigger change than this plan should carry. Watch it; revisit if
   multi-window becomes common.

4. **The injected runtime breaking a page the user is browsing.** `rama-hook`
   runs on *every* page, including ones the user opened for themselves. AB1's
   "no exceptions escape" rule is the mitigation, and it deserves a test that
   asserts a page's own `console.log` return value and `fetch` semantics are
   unchanged. A browser tool that subtly breaks the pages it reads is worse than
   one that reads nothing.

5. **Agent clicking things on the real internet.** AB4's loopback-vs-internet
   split is the structural answer. It is deliberately not configurable-to-off in
   this plan's default settings; a user who wants an agent clicking freely on
   github.com can set the project rule themselves.

6. **Token budgets rotting.** Real sites change; a snapshot that was 1,200
   tokens becomes 4,000 and nobody notices until a context window fills. AB2's
   fixtures are saved HTML, checked in, and their budgets asserted — the budget
   is a test, not a comment.

---

## 10. Open questions

1. **Does the walker need viewport awareness?** Restricting the default snapshot
   to the visible viewport plus a screenful would cut infinite-scroll feeds
   dramatically, but silently hides real controls and makes "the button is not
   there" mean two things. **Leaning: no viewport filter by default**, but emit
   `… 40 more items below the fold` so the model can ask. Absence keeps one
   meaning; §6.1's dedupe already handles most of the cost.

2. **Should `open` auto-snapshot?** Every `open` is followed by a snapshot in
   practice, and merging them saves a round trip and a tool call. Against: it
   makes `open` expensive for the common "start a dev server and check it boots"
   case where the agent only wants a title and a console check. **Leaning: add
   `snapshot: true` as an opt-in flag on `open` rather than changing the
   default**, and revisit once there is real transcript evidence.

3. **Where do scenarios live — project files or the database?** Files
   (`.rama/scenarios/`) make them reviewable, diffable, and committable with the
   code they test, which fits the self-improvement story. The DB fits
   `WORKSPACE_PANES_PLAN.md`'s existing artifact plumbing. **Leaning: files.** A
   test that is not in the repo with the code is not a test.

4. **Does `type` need per-character keyboard events?** Some autocomplete widgets
   listen for `keydown` per character and will not fire on a bulk `input`.
   Per-character dispatch is slow and mostly unnecessary. **Leaning: bulk by
   default, with `perChar: true` if a real widget forces it** — do not
   speculatively pay for it.

5. **Should the human-facing Web pane show agent refs?** Overlaying the numbered
   badges on the live page while an agent drives it would make its behaviour
   legible and debuggable, and it is a genuinely attractive demo. It is also
   pure UI work with no bearing on correctness. **Leaning: not in this plan** —
   record it for `WORKSPACE_PANES_PLAN.md` once AB2 exists to feed it.

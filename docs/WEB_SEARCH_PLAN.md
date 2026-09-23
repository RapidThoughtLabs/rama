# Rama — Web Search Implementation Plan

Phases here are **WS0–WS6** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7 (`LOOP_MIGRATION_PLAN.md`),
loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`), workspace panes W0–W7
(`WORKSPACE_PANES_PLAN.md`), symbol layer SL0–SL6 (`SYMBOL_LAYER_PLAN.md`),
agent browser AB0–AB7 (`AGENT_BROWSER_PLAN.md`), chat view CV0–CV6
(`CHAT_VIEW_PLAN.md`), or context budget CB0–CB6
(`CONTEXT_BUDGET_PLAN.md`). Cite these as "WEB_SEARCH_PLAN.md Phase WS3".

**`WS` is always written in full** — `WS3`, never `W3` — because workspace panes
already own `W0–W7` and the two would otherwise be one keystroke apart in a
grep.

**What this document owns.** Everything between "an agent needs a fact that is
not in the repo and not in its weights" and "a result small enough to be worth
a context window." It does not own the `browser` tool and its live page session
(`AGENT_BROWSER_PLAN.md`), the in-app command-palette search registry
(`engine/src/search/`, `IMPLEMENTATION_PLAN.md` Phase 6), or MCP-provided search
servers (`TOOL_LAYER_PLAN.md` TL7 / heku) — though §2 explains why the last of
those is not the primary path.

**The motivating use case is not research.** It is *the agent checking a
library's current API, or a current version number, before it writes code
against it.* Every decision below is settled by that sentence, and where "great
general research agent" and "cheap, correct lookup inside a coding turn"
disagree, this document picks the second.

---

## 1. The framing: four claims that decide everything else

**1. Search and fetch are two capabilities, not one, and providers cover them
unevenly.** This is the structural fact the whole abstraction hangs on:

| provider | search | extract page content | key required |
|---|---|---|---|
| Tavily | yes | yes | yes |
| Exa | yes | yes | yes |
| Firecrawl | yes | yes | yes |
| Brave | yes | no | yes |
| SearXNG | yes | no | **no** (self-hosted) |
| Jina Reader | no | yes | no (rate-limited) |

A design with one `search()` that sometimes returns content and sometimes does
not is a design that lies to its caller. Two operations, each independently
capability-gated, is the only shape that fits the table above. **And Rama is
better positioned here than the harnesses it is copying from:** it already owns
a fetch path — the Tauri webview, plus AB1's page runtime. Cline and Goose had
to buy both halves; Rama only needs to buy the half it cannot already do, and
only if the user wants to.

**2. Richness varies, so capability flags — not a lowest-common-denominator
type.** Normalize around Tavily's payload and every SearXNG result is a
half-empty struct; normalize around SearXNG's floor and the thing the user is
paying Tavily for is discarded at the seam. This is exactly the problem
`catalog.ts` already solved for models with `supportsTools` /
`supportsThinking` / `supportsVision` (`engine/src/agent/catalog.ts:29-45`):
optional fields on the result, honest flags on the client, and a caller that
checks rather than assumes.

**3. The tool's JSON schema must not change when the provider changes.**
`toolInventory.ts:23`'s `generateToolInventory` renders layer 0 of the prompt
from the exact `RamaToolSet` handed to the transport, and `sortTools` (`:8`)
fixes its order precisely so that layer is byte-stable. Layer 0 is the cached
prefix (`PROMPT_STACK_PLAN.md` §9.2, Phase PS1). If the `web` tool's schema or
description varied by configured provider, a user switching Tavily → SearXNG
would silently invalidate the cached prefix of **every chat in the app**, and
the symptom would show up as a bill, not a bug. So: one static schema, always
the union of parameters, and adapters that cannot honor a parameter say so *in
the result body* instead of removing it from the schema.

**4. In a coding turn, the snippet is the product.** `browser.ts:85` already
holds page reads to `MODEL_OUTPUT_CHARS = 8_000` through `headTailTruncate`.
Search gets the same discipline, harder: a `search` returns title + URL + a
short snippet per hit and nothing else. Full page content is an explicit second
call the model has to decide to make. Tavily's `include_raw_content` is a trap
for exactly this reason — it turns one lookup into 20k tokens, and per
`CONTEXT_BUDGET_PLAN.md` those tokens are then re-sent on every subsequent turn
of the chat.

A corollary, and it is the same lesson `AGENT_BROWSER_PLAN.md` §1 learned the
hard way: **if the cheap tool does not exist, the model reaches for the
expensive one.** There it shelled out to `bash` to click a button. Here it will
open a browser window and scrape a results page to look up a version number.
That is not misbehavior, it is a missing capability, and no amount of prompt
text fixes it.

---

## 2. Why not the five easier paths

Considered and rejected, not deferred:

| Option | Why not |
|---|---|
| **Provider-side server tools** (Anthropic's hosted `web_search`, OpenAI's Responses-API search) | Zero dependencies and zero infra, and genuinely tempting. But it binds a *tool's existence* to *which model is selected*, and Rama's entire tool layer is provider-agnostic by construction — `resolveClient` (`llm/client.ts:23`) exists precisely so the loop above it never asks who the provider is. Search would become the one tool that silently vanishes on a Together or Ollama chat. It also changes the tool inventory per chat, which is claim 3's cache problem arriving through a different door. |
| **Scrape a SERP with the `browser` tool** | Works today with zero new code, and is wrong on every axis that matters: a window opens, a real page loads, JS runs, and the model pays for a full `read` to extract ten links. Stateful, serial, ~2-15s per query, and it burns the one webview the user may be watching. The cheap-tool corollary in §1 exists to prevent exactly this. |
| **MCP search server only** (Exa MCP, Tavily MCP, Brave MCP) | Rama has MCP and heku (`TOOL_LAYER_PLAN.md` TL7), so this is nearly free — and it stays available for exotic providers. It is not the *primary* path because the tool schema then comes from the server, so it differs per provider (claim 3 again), keys live outside the OS keychain that `secrets.ts` deliberately owns, and each server is a node/python process to supervise for what is fundamentally one HTTPS POST. A built-in should not require a subprocess. |
| **A data-driven adapter DSL** (describe each provider in JSON: endpoint, method, JSONPath for results) | Seductive — new providers become a config edit. It collapses on auth quirks, pagination, error envelopes and rate-limit semantics, and the debugging surface becomes a homegrown mini-language rather than 40 lines of TypeScript. Split it the way the LLM layer is already split: **JSON for metadata, code for adapters.** `catalog.ts` is data; `encode.ts`/`decode.ts` are code. |
| **Fan out to N providers and merge** | Doubles or triples latency and cost for a marginal recall gain, and introduces a dedup-and-rerank problem that is a project in itself. A single active provider with an *optional* ordered fallback (WS6) gets the resilience without the bill. |
| **Reuse the `providers` table** | It would mean a `kind` column where `anthropic` and `searxng` are peers, and a `provider_models` roster (`schema.ts:95`) that is meaningless for a search engine. Copy the column *design* — §7 does, almost verbatim — but not the table. |

---

## 3. What is actually there today

Read before planning; the phases are built on these facts.

| finding | where |
|---|---|
| There is **no web search of any kind**. The tool registry is 19 tools; the only one that touches the network is `browser`. | `engine/src/tools/index.ts:22-48`, `:37` |
| `engine/src/search/` is *in-app* search (tools, skills, mcp, docs, commands) for the command palette. Unrelated to the web — but it already exports an interface named **`SearchProvider`**. | `engine/src/search/types.ts:24` |
| The LLM layer is the pattern to copy: provider-agnostic types, one dispatch function, per-provider folders. | `engine/src/llm/types.ts`, `client.ts:23`, `llm/anthropic/`, `llm/openai/` |
| `resolveClient(providerRow, model, apiKey)` already handles bearer-vs-header auth, arbitrary extra headers, and keyless endpoints. All three recur verbatim for search providers. | `engine/src/llm/client.ts:23-60` |
| API keys live in the OS keychain (owned by the Rust core), are pushed to the engine over loopback, held in a **flat in-memory `Map` keyed by provider id**, and never touch SQLite or disk. | `engine/src/secrets.ts:6-14` |
| The `providers` table was created with 5 columns and everything since has been bolted on with `addColumnIfMissing`. | `schema.ts:82-88`, `db/index.ts:21-26` |
| `requires_key` is a per-row column precisely because keyless custom endpoints (Ollama, vLLM, LM Studio) exist. SearXNG is the same case. | `db/providers.ts:20-40`, `PROVIDERS_PLAN.md` P3 |
| `PermissionTool` is a closed union of five; `browser` rides on the `web` bucket rather than owning one. | `packages/protocol/src/index.ts:523`, `permissions.ts:20-21` |
| The `web` permission defaults to `allow`. | `db/settings.ts:12` |
| Tools are defined by `defineTool` with a zod schema, and gate through `gate(ctx, {name, input, risk}, run)`. | `tools/define.ts:61`, `permissions.ts:139`, `browser.ts:300` |
| Model-facing output is capped at 8,000 chars via `headTailTruncate`. | `browser.ts:85`, `:216`, `truncate.ts:6` |
| The prompt's tool inventory is generated from the live tool set, sorted by name, so wire schemas and prose can never drift. | `agent/prompt/toolInventory.ts:8`, `:23` |
| The catalog merges a bundled JSON with `~/.rama/catalog.json`, per-provider and per-model, user wins on collision. | `agent/catalog.ts:70-90` |
| Settings is a fixed 8-pane list. | `apps/desktop/src/app/SettingsModal.tsx:28-36` |
| Provider health is polled on a 30s cadence driven from `ProvidersProvider`. | `engine/src/providerHealth.ts:38` |

Two consequences worth stating plainly, because they shorten the plan:
**secrets and permissions need no new mechanism at all** — a search provider id
drops into the existing keychain map, and the `web` bucket already exists and
already defaults to `allow`.

---

## 4. The unknowns, and the spike that settles them (WS0)

Unlike `AGENT_BROWSER_PLAN.md` §4, none of these can force a redesign — the
engine is a Bun process making ordinary HTTPS calls, so there is no transport
risk. They are *budget* unknowns, and §1 claim 4 is a number this plan does not
have yet. Table is **hypotheses**, to be rewritten as results in WS0:

| # | Hypothesis | If false |
|---|---|---|
| 1 | A 5-result search response, rendered per §8, costs **under 600 tokens**. | Cut default `maxResults` to 3 and shorten the snippet cap until it does. The budget is the requirement; the result count is the variable. |
| 2 | Public SearXNG instances answer `&format=json` reliably enough to be a default. | Ship SearXNG as a *self-hosted* path only, documented with a compose file, and default the picker to a keyed provider. Do not ship a default that works on the author's machine and rate-limits on everyone else's. |
| 3 | A server-side HTML → text pass (fetch + Readability-style extraction) gets usable prose from the top 20 documentation sites without running JS. | The `fetch` op escalates to the webview + AB1 page runtime for JS-only pages, and WS4 grows a second code path. |
| 4 | Tavily, Brave and SearXNG can all be expressed through §5's types without any adapter needing a field outside them. | The type is wrong. Fix it in WS3 while there are only two adapters, not in WS6 when there are four. |
| 5 | Search + one fetch, end to end, lands under 4s p50 from a cold engine. | Investigate before adding a fallback chain — a slow primary makes a chain worse, not better. |

**WS0 writes real numbers into this table.** Nothing downstream is trustworthy
until it does; this is the same discipline `CONTEXT_BUDGET_PLAN.md` CB0 and
`SYMBOL_LAYER_PLAN.md` §4 apply, and for the same reason.

---

## 5. The normalized types

`engine/src/websearch/types.ts` — provider-agnostic, no vendor vocabulary. The
naming deliberately parallels `llm/types.ts`, and deliberately avoids
`SearchProvider`, which `engine/src/search/types.ts:24` already owns.

```ts
export interface WebQuery {
  query: string;
  /** Adapter clamps to capabilities.maxResultsCap. */
  maxResults?: number;
  /** Domain allow-list, e.g. ["docs.python.org"]. */
  site?: string[];
  recency?: "day" | "week" | "month" | "year";
  topic?: "general" | "news";
}

export interface WebResult {
  title: string;
  url: string;
  /** Always present. Capped at SNIPPET_CHARS by the adapter, not the caller. */
  snippet: string;
  publishedAt?: number;
  /** Provider-native relevance, when it has one. Never synthesized. */
  score?: number;
  /** Only when capabilities.returnsContent. Never populated by default — see §8. */
  content?: string;
}

export interface WebSearchResponse {
  results: WebResult[];
  /** Only when capabilities.answersDirectly, and only surfaced per §12 Q1. */
  answer?: string;
  /**
   * Parameters the caller asked for that this adapter could not honor.
   * The mechanism that makes claim 3's static schema honest: the schema never
   * shrinks, the result admits what was ignored.
   */
  ignored: (keyof WebQuery)[];
}

export interface WebFetchResult {
  url: string;
  title?: string;
  /** Extracted prose. Truncation is the tool's job, not the client's. */
  text: string;
  /** "provider" | "readability" | "webview" — for debugging a bad extraction. */
  via: string;
}

export interface WebSearchCapabilities {
  returnsContent: boolean;
  answersDirectly: boolean;
  supportsSiteFilter: boolean;
  supportsRecency: boolean;
  supportsTopic: boolean;
  supportsFetch: boolean;
  maxResultsCap: number;
}

export interface WebSearchClient {
  readonly id: string;
  readonly capabilities: WebSearchCapabilities;
  search(q: WebQuery, signal: AbortSignal): Promise<WebSearchResponse>;
  /** Present iff capabilities.supportsFetch. Composed with a local extractor in WS4. */
  fetch?(url: string, signal: AbortSignal): Promise<WebFetchResult>;
}
```

`engine/src/websearch/client.ts` mirrors `llm/client.ts:23` exactly:

```ts
export function resolveWebClient(
  row: SearchProviderRow,
  apiKey: string | undefined,
): WebSearchClient
```

Same responsibilities, same order: parse `extra_headers_json`, apply
header-vs-bearer auth, omit auth entirely when `requires_key` is 0, dispatch on
`row.kind`.

---

## 6. Decisions taken in this pass (2026-09-20)

1. **One tool named `web`, two ops (`search`, `fetch`)** — not two tools. The
   prompt inventory is one line per tool (`toolInventory.ts:23`), and the
   op-discriminated shape matches `browser.ts` exactly, so there is nothing new
   for a reader of the codebase to learn. `permissionToolFor` gains a
   one-line identity case: `case "web": return "web"`.

2. **`web` and `browser` must be told apart in their descriptions, explicitly.**
   `web` is a stateless lookup with no window; `browser` is a live page in the
   user's real session. Without a sentence saying so in both descriptions the
   model will use `browser` for lookups — the §1 corollary, running in reverse.

3. **Static tool schema across providers**, with `ignored` carrying the
   degradation. Claim 3. A test asserts schema stability (§11 risk 6).

4. **Search never returns page content.** `content` exists on the type for the
   providers that return it, and WS2's renderer does not print it. Getting
   content is `op: "fetch"`.

5. **New `search_providers` table**, columns copied from `providers` — but all
   of them in the `CREATE TABLE`, not accreted through `addColumnIfMissing`.
   There is no released version of this table, so there is no migration debt to
   inherit. (`db/index.ts:21-26` is the tax `providers` pays for having been
   created with five columns.)

6. **Keychain ids are namespaced `search:<id>`.** `secrets.ts:6` is a single
   flat `Map` keyed by provider id, and `openai` is plausibly both an LLM
   provider and (one day) a search provider. Prefix now, while the namespace is
   empty.

7. **Single active provider**, selected in settings. An ordered fallback chain
   is a `FallbackWebClient implements WebSearchClient` wrapper in WS6 —
   composition at the seam, not a special case inside it.

8. **Adapters are code; provider metadata is JSON**, bundled +
   `~/.rama/websearch-catalog.json` override, user wins on collision — the same
   shape as `catalog.ts:70-90` and `themes/store.ts`. A user can add a custom
   SearXNG instance without a rebuild; they cannot add a *new vendor protocol*
   without an adapter, and §2 explains why that trade is correct.

---

## 7. Storage, config and keys

```sql
CREATE TABLE IF NOT EXISTS search_providers (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,          -- adapter selector: tavily|brave|exa|searxng
  base_url           TEXT,                   -- required for searxng, optional elsewhere
  label              TEXT,
  enabled            INTEGER NOT NULL DEFAULT 0,
  requires_key       INTEGER NOT NULL DEFAULT 1,
  auth_style         TEXT NOT NULL DEFAULT 'bearer',
  auth_header        TEXT,
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  is_custom          INTEGER NOT NULL DEFAULT 0,
  last_health_status TEXT,
  last_health_at     INTEGER,
  created_at         INTEGER NOT NULL
);
```

The active provider is a single row in `settings` (`websearch.activeProviderId`),
read through `getSetting` like every other preference — not a column on the
table, so "which one is on" is one write, not a table-wide update.

**Catalog** (`engine/src/websearch/catalog.json`, overridable at
`~/.rama/websearch-catalog.json`): per provider, the `kind`, default
`base_url`, `requires_key`, `auth_style`/`auth_header`, the free-tier note the
settings pane shows, and the `WebSearchCapabilities` block. Capabilities live
in the catalog rather than hardcoded in the adapter so that a user pointing at
a SearXNG instance with unusual engines enabled can correct
`supportsRecency` without a code change.

**Keys**: `setSecret("search:tavily", key)` — no new mechanism (§3), no schema
column, nothing written to disk. SearXNG rows have `requires_key = 0` and the
settings pane must not prompt for a key it does not need, which is the
`providerRequiresKey` lesson from `PROVIDERS_PLAN.md` P3 applied one layer over.

---

## 8. The wire format — what the model sees

`op: "search"`, 5 results, the §4 hypothesis-1 budget:

```
web search: "tauri v2 webview navigation api"  ·  brave  ·  5 results

1. Window & Webview | Tauri
   https://v2.tauri.app/reference/javascript/api/namespacewebview/
   WebviewWindow class, navigate(url), onNavigation handler; v2 splits the v1
   Window API into Window and Webview namespaces.

2. ...

(recency filter not supported by this provider)
```

Rules, in priority order:

- Title, URL, snippet. Snippet capped at ~240 chars **by the adapter**, so a
  verbose provider cannot blow the budget by being verbose.
- The provider id is printed. When an answer is wrong, the first question is
  which index produced it.
- `ignored` renders as one parenthesized line at the end. This is the whole
  honesty mechanism for the static schema — the model asked for recency, it did
  not get recency, and it is told rather than left to assume.
- No `content`, ever, on a search (decision 4).

`op: "fetch"` returns extracted prose through `headTailTruncate` at
`MODEL_OUTPUT_CHARS`, prefixed with the URL, the title, and `via` so a bad
extraction is diagnosable from the transcript alone.

---

## 9. Phases

### WS0 — measure before building

No production code. A throwaway script under the scratchpad hitting Tavily,
Brave and two SearXNG instances with the same five realistic developer queries
("tauri 2 webview navigate api", "bun test coverage flag", and similar), plus a
fetch-and-extract pass over the top 20 documentation domains.

Answer §4's five hypotheses, in order 1, 2, 3, 5, 4, and **rewrite §4 as a
results table**. If hypothesis 1 fails, the fix is the snippet cap and the
default result count, decided here and hardcoded in WS2 — not tuned later by
feel.

**Acceptance:** §4 contains real numbers, measured, with the date. The default
`maxResults` and `SNIPPET_CHARS` constants for WS2 are named in it.

### WS1 — the seam and the store

`engine/src/websearch/types.ts` (§5 verbatim), `client.ts` with
`resolveWebClient` throwing `unknown search provider kind` for everything,
`catalog.ts` (bundled + `~/.rama` override, cloned from
`agent/catalog.ts:70-90`), the `search_providers` table in `schema.ts`, and a
`db/searchProviders.ts` with the `getProvider`/`listProviders`/`configure`
trio. No adapters. No tool. No UI. Nothing in the agent path changes.

**Acceptance:** `bun test engine/src/websearch/` green against a fake adapter
constructed in the test; `createTools` output byte-identical to before;
`generateToolInventory` still renders 19 tools.

### WS2 — Tavily, and the `web` tool

First end-to-end. `websearch/tavily/index.ts` (~60 lines: POST, map, clamp,
populate `ignored`), and `engine/src/tools/web.ts` — `defineTool`, zod schema
per §5's `WebQuery` plus `op`, `gate(ctx, { name: "web", input, risk: "low" })`,
rendering per §8. `permissionToolFor` gains its identity case. `fetch` op
returns "not supported by the configured provider" and is finished in WS4.

Tool descriptions carry decision 2's `web`-vs-`browser` sentence.

**Acceptance:** from a real chat, a question whose answer is not in the weights
is answered in one `web` call; the rendered block is under the WS0 budget;
`ignored` is non-empty and rendered when a `recency` filter is passed to a
provider that lacks one.

### WS3 — SearXNG: the keyless half, and the abstraction's real test

`websearch/searxng/index.ts` against `{base_url}/search?format=json`. Row has
`requires_key = 0` and a mandatory `base_url` — the Ollama-shaped case
`providerRequiresKey` was built for. No `answer`, no `content`,
`supportsFetch: false`; `site`/`recency` map to the instance's engine syntax
where it exists and land in `ignored` where it does not.

**This phase judges §5.** If SearXNG cannot be expressed in those types without
adding a field, the types were wrong and they get fixed here, with two adapters
in the tree, rather than in WS6 with four. Per §4 hypothesis 2, WS0's numbers
decide whether the shipped default is a public instance or a documented
self-hosted compose file.

**Acceptance:** the WS2 query, run through SearXNG, produces the same *shape* —
the model cannot tell from the schema which provider answered, only from the
content and the degradation line. Swapping providers does not change
`generateToolInventory`'s output by a single byte (assert it).

### WS4 — the fetch half

`op: "fetch"` lands. Two sources, chosen by capability:

- `capabilities.supportsFetch` → the provider's own extract endpoint.
- Otherwise → the local keyless extractor: `fetch()` in the engine, then a
  Readability-style main-content pass, then HTML → text. `via: "readability"`.

Per §4 hypothesis 3, if the local pass fails on JS-rendered docs, the escalation
is the existing webview + AB1's page runtime (`via: "webview"`) — explicitly the
last resort, because it costs a window and serializes.

**Acceptance:** `fetch` on a page from each of the WS0 top-20 domains returns
prose a human would call correct, under `MODEL_OUTPUT_CHARS`, with `via`
recorded. SearXNG + local extractor together do search *and* fetch with no API
key anywhere in the system.

### WS5 — settings, health, picker

A `search` pane in `SettingsModal.tsx:28-36` (after `providers & models`): the
catalog list, key field shown only when `requires_key`, `base_url` field shown
for custom/self-hosted, one active-provider radio, and a test-query button.
Health probe folded onto the existing 30s poll (`providerHealth.ts:38`),
writing `last_health_status`/`last_health_at` exactly as providers do, so the
pane can boot from "was fine yesterday" rather than blank
(`PROVIDERS_PLAN.md` P1 guard 1).

**Acceptance:** configure Tavily and a SearXNG instance from a cold app,
switch between them, and run a query on each without restarting the engine.
Removing the key leaves the row and degrades to `last_health_status: error`
rather than deleting configuration.

### WS6 — the second closed adapter, and fallback

Brave (or Exa, if WS0's relevance numbers argue for it), plus
`FallbackWebClient implements WebSearchClient` — an ordered list, first
non-erroring wins, `ignored` unioned, provider id in the output reflecting who
actually answered. Off by default.

**An abstraction with one adapter is a wrapper; with two it is a guess; only at
three is it tested.** This phase exists to find what §5 got wrong, and its real
deliverable is whatever change that forces.

**Acceptance:** three adapters, one test suite parameterized across all of them
asserting the same invariants (result shape, snippet cap, `ignored` honesty,
schema stability). Fallback demonstrably survives the primary returning 429.

---

## 10. Order and dependencies

WS0 → WS1 → WS2 are strictly serial. WS3 depends on WS1 only (it can be written
alongside WS2 by a second pair of hands, and is more useful if it is —
two adapters written against the same fresh types catch more than one written
then one retrofitted). WS4 depends on WS2. WS5 depends on WS3 (it needs a
keyless row to render correctly). WS6 depends on WS4 and WS5.

The keyless-only slice — **WS1 + WS3 + WS4's local extractor** — is a complete,
shippable product with no vendor, no key, and no bill. That is the fallback if
this plan has to stop early, and it is worth keeping shippable at every phase
boundary for that reason.

---

## 11. Risk register

1. **Fetch blows the context budget.** The single highest-cost failure here, and
   `CONTEXT_BUDGET_PLAN.md` exists because Rama has already been bitten by
   provider-side token growth. One page can be 50k tokens, and per CB's
   diagnosis it is then re-sent every turn for the rest of the chat.
   Mitigations: `content` is never on a search result (decision 4), `fetch` is
   truncated at `MODEL_OUTPUT_CHARS`, and WS4 should land *after* CB1's
   persisted-compaction work so that a large fetch can actually be pruned.

2. **Public SearXNG instances are not a product.** They rate-limit, block
   non-browser user agents, and disable `format=json`. Shipping one as the
   default would work on the author's machine and fail for users — the worst
   failure shape. §4 hypothesis 2 settles it in WS0, and the honest answer is
   probably "self-hosting is the supported path, a public instance is
   best-effort."

3. **The model confuses `web` and `browser`.** It will reach for whichever the
   prompt makes sound more capable. Decision 2's descriptions are the
   mitigation; if it still mis-routes after WS2, the fix is in the mode layer
   (`prompt/mode.ts`), not in more tool description.

4. **Vendor response-shape drift.** Adapters are small, but they are parsing
   someone else's JSON on someone else's schedule. Each adapter ships with a
   recorded-fixture test so a shape change fails in CI rather than in a user's
   chat, and adapter errors surface as `last_health_status`, not exceptions.

5. **Keychain id collision.** Decision 6 prefixes `search:`, which is correct
   going forward. Worth one grep before WS1 to confirm nothing writes an
   unprefixed id that could collide.

6. **Someone later adds a provider-specific parameter to the schema.** This is
   claim 3's failure mode, it is silent, and it costs money rather than
   throwing. Mitigation is mechanical: a test that hashes the `web` tool's
   resolved `inputSchema` + description and asserts it is identical across
   every configured provider. It belongs in WS2, before there is a second
   adapter to tempt anyone.

---

## 12. Open questions

**Q1. Should `answer` ever reach the model?** Tavily and Exa will synthesize
one. It is cheap and often right — and it is a second model's summary, arriving
without provenance, which the agent will then treat as a source. Current lean:
plumb it through the type (WS1), do not render it (WS2), and revisit with a
real failure or a real need. Rendering it is a one-line change; un-teaching a
model to trust it is not.

**Q2. Per-project provider override.** `getProjectPermissions` already
establishes project-over-global for permissions. Plausibly the same for search
(a work repo on a self-hosted instance, a personal one on Tavily). Not in
WS0–WS6; note the shape now so the settings read path in WS5 is not written in
a way that forbids it.

**Q3. Do search results belong in the artifact store?** `CONTEXT_BUDGET_PLAN.md`
D1's principle — persist the decision, never destroy the bytes — suggests the
full result set should be an artifact even though only a truncated render
reaches the model, so the human transcript can show what was actually returned.
Deferred, but it is a WS2 decision if it is going to happen cheaply.

**Q4. Rate limiting and caching.** Two identical queries in one chat should not
be two API calls. A small in-memory LRU on `(providerId, normalized query)` is
maybe 20 lines and saves real money on a looping agent. Not scoped above;
revisit once WS0 says what a query actually costs.

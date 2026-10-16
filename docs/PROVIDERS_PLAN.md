# Rama — Providers & Models Implementation Plan (pass 01)

Phases here are numbered **P0–P6** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md`, the redesign phases R0–R7 in
`docs/REDESIGN_PLAN.md`, or the settings phases S0–S5 in
`docs/SETTINGS_PLAN.md`. Cite these as "PROVIDERS_PLAN.md Phase P3".

**This document supersedes `SETTINGS_PLAN.md` Phase S5.** S5 correctly
identified that the providers pane presents Rama's *catalog* as if it were the
user's *configuration*, and that a custom provider is unbuildable while
`MODEL_REGISTRY` is a hardcoded object. It then tried to fix both with a single
wizard phase. That is too big to land in one piece and it leaves three other
problems untouched: the composer picker shows models nobody can reach, the model
list goes stale the moment a provider ships something, and there is no cheap
model available for background work. S5's schema sketch, migration rule and
"do not finish on a failed verify" rule all survive here, restated in place.

It also absorbs one bullet from **S4**: the "default provider + model" setting.
That is not a standalone setting — it is one row in the role table this plan
introduces in P2. S4 should drop the bullet and link here.

---

## The framing: three lists wearing one trench coat

Every problem in this plan is a symptom of one thing. `MODEL_REGISTRY` in
`engine/src/agent/config.ts:28` is a single hardcoded object pretending to be
three lists that have different owners, different lifetimes, and different
failure modes.

| list | what it is | owner | changes when |
|---|---|---|---|
| **catalog** | what Rama *knows exists* — pricing, context window, tool/thinking flags, tier | Rama (and the user's override file) | Rama ships, or the user edits their file |
| **roster** | what this key can *actually reach today*, per provider | the provider | the provider deploys |
| **shortlist** | the 4–6 models the user ticked — the only ones the composer ever offers | the user | the user ticks a box |

Split those three and the rest falls out:

- the **wizard** is the flow that walks catalog → roster → shortlist
- the **filtered picker** is shortlist ∩ reachable
- **staying current** is: refresh the roster, diff it against the shortlist,
  never mutate the shortlist
- the **cheap utility model** is a *role* pointing into the shortlist,
  defaulted from a catalog hint

**The merge rule, which settles a dozen later arguments:**

> **Fetch decides existence. Catalog decides meaning.**

Neither source is sufficient alone. `GET /models` tells you what is live but
gives you almost nothing usable — OpenAI's returns ~50 ids including
`whisper-1`, `dall-e-3`, embeddings and a pile of dated snapshots, with no
pricing and no capability flags. Anthropic's returns `id` + `display_name` and
nothing else. The catalog has the good metadata and goes stale on release
cadence. And for Ollama the fetch is the *only* truth: the catalog is
meaningless, the answer is literally whatever the user has pulled locally.

So a `provider_models` row is not tagged with one source. It records *both*,
and both-at-once is the healthy state.

---

## Rules that hold across every phase

1. **Each phase ships runnable.** `main` never boots broken.
2. **The non-interference invariant.** A background refresh may **add** rows in
   a `new` state and **mark** rows `missing`. It may never flip `enabled`, never
   change a chat's model, never change a role assignment, never change the
   default. *The catalog updates itself; the shortlist only moves when a human
   ticks a box.* Every phase below is checked against this sentence.
3. **No settings UI for a subsystem that does not exist.** Inherited from R2/R4/R6
   and S4. Where this plan bends it, it says so.
4. **A refresh never blocks a paint or a send.** All roster and enrichment work
   is background, cached, and fails silent.
5. **Never guess a price.** No pricing is `0` and renders as "no pricing", not a
   number borrowed from a different model. See the P0 note on `estimateCostUsd`.
6. Anything touching CSS is checked in **a dark and a light** theme before it
   lands (R0's rule).

---

## What is actually there today

Read before planning; these are the facts the phases below are built on.

| finding | where |
|---|---|
| `MODEL_REGISTRY` is a static object keyed by the six seed provider ids. `getModelsForProvider` returns `[]` for anything else — a custom provider would have zero models and be unusable. | `engine/src/agent/config.ts:28`, `:151` |
| `estimateCostUsd` falls back to `MODEL_REGISTRY[DEFAULT_PROVIDER_ID][0]` for any unknown model — i.e. it reports **Together's Llama pricing** for models it has never heard of, silently. | `engine/src/agent/config.ts:155` |
| `checkProviderHealth` already does `GET {baseUrl}/models` and **throws the response body away**. | `engine/src/providerHealth.ts:33` |
| That probe runs every **30s** for every provider. | `apps/desktop/src/app/data/ProvidersProvider.tsx:17` |
| `seedProviders()` runs on every boot and `INSERT OR IGNORE`s all six `SEED_PROVIDERS`. A row in `providers` therefore means "Rama knows this exists", not "the user set this up". | `engine/src/db/providers.ts:38`, called at `engine/src/db/index.ts:46` |
| `requiresKey` comes from `REQUIRES_KEY`, a map keyed by seed id. A custom provider is not in it and silently defaults to `true`. | `engine/src/db/providers.ts:34` |
| `loop.ts` gates on `providerId !== "ollama"` rather than `providerRequiresKey()` — a keyless custom endpoint (LM Studio, vLLM) is blocked with "no key configured". | `engine/src/agent/loop.ts:97` |
| `ModelPicker` renders **every** provider and **every** model, healthy or not; unreachable providers get a coloured dot and are still selectable. | `apps/desktop/src/app/ModelPicker.tsx:57` |
| Default provider/model are two consts, unreachable from the UI. Every new chat starts on Together's Llama 3.3 70B whether or not Together is configured. | `engine/src/agent/config.ts:8` |
| Every chat is titled **`"new chat"`** and nothing ever renames it. | `engine/src/db/chats.ts:77` |
| There *is* a migration helper — `addColumnIfMissing(table, column, ddl)`, PRAGMA-guarded. New columns do not need a migration framework. | `engine/src/db/index.ts:22` |
| `secrets.rs` has `set_provider_key` and `get_provider_key`. **There is no delete.** Removing a provider needs a new Tauri command. | `apps/desktop/src-tauri/src/secrets.rs` |
| Engine-side secrets are in-memory only and lost on every engine restart; the webview re-pushes from the keychain on boot. | `engine/src/secrets.ts`, `ProvidersProvider.tsx:51` |
| There is no `chat.renamed` / `chat.updated` event in `SessionEvent`. Auto-titling needs one. | `packages/protocol/src/index.ts:10` |

---

## Phase P0 — The three lists, split

**Engine only. No visible UI change.** This is the unlock for every phase after
it, and it is the phase to do first even though it ships nothing a user can see.

### The catalog becomes a file

`MODEL_REGISTRY` and `SEED_PROVIDERS` merge into one bundled
`engine/src/agent/catalog.json`, overlaid by `~/.rama/catalog.json` if present,
**user wins on id collision** — the same mechanism S1 settled on for themes
(bundled builtins + `~/.rama/themes`, live-merged). Consistency with an
already-made decision, not a new one.

Two things this buys beyond tidiness: adding Fireworks, DeepSeek, Mistral, xAI,
Cerebras, LM Studio or vLLM costs one JSON entry and no DB work; and a user on a
negotiated enterprise rate can correct their own pricing without a fork. For an
app positioning as an enterprise LLM layer that is not hypothetical.

```jsonc
{
  "providers": [
    {
      "id": "groq",
      "label": "Groq",
      "kind": "openai-compatible",
      "baseUrl": "https://api.groq.com/openai/v1",
      "requiresKey": true,
      "docsUrl": "https://console.groq.com/keys",
      "authStyle": "bearer",              // "bearer" | "header"
      "authHeader": null,                 // e.g. "x-api-key" when authStyle=header
      "extraHeaders": {},                 // OpenRouter wants HTTP-Referer / X-Title
      "utilityModel": "llama-3.1-8b-instant",
      "models": [
        {
          "id": "llama-3.1-8b-instant",
          "label": "Llama 3.1 8B Instant",
          "tier": "small",                // "frontier" | "workhorse" | "small"
          "supportsTools": true,
          "supportsThinking": false,
          "supportsVision": false,
          "contextWindow": 128000,
          "inputPerMillion": 0.05,
          "outputPerMillion": 0.08,
          "defaultEnabled": true,
          "openrouterId": "meta-llama/llama-3.1-8b-instruct",
          "deprecated": false,
          "supersededBy": null
        }
      ]
    }
  ]
}
```

`tier` is new and load-bearing: P2's role defaulting reads it, and the model
list sorts by it. `defaultEnabled` is what the wizard pre-ticks — three to six
per provider, never the whole list.

### `provider_models`

New table. A row can be catalog-known *and* fetch-confirmed at once, so source
is three independent fields, not S5's flat enum.

```sql
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id      TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  label            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  pinned           INTEGER NOT NULL DEFAULT 0,  -- user wants it even if /models omits it
  in_catalog       INTEGER NOT NULL DEFAULT 0,
  fetched_at       INTEGER,                     -- last time /models listed it; NULL = never
  added_manually   INTEGER NOT NULL DEFAULT 0,
  supports_tools   INTEGER,
  supports_thinking INTEGER,
  supports_vision  INTEGER,
  context_window   INTEGER,
  input_per_million  REAL,                      -- NULL = unknown, never 0-as-unknown
  output_per_million REAL,
  price_source     TEXT,                        -- 'catalog' | 'user' | 'openrouter' | NULL
  tier             TEXT,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  deprecated       INTEGER NOT NULL DEFAULT 0,
  superseded_by    TEXT,
  last_error       TEXT,
  last_error_at    INTEGER,
  last_error_kind  TEXT,                        -- 'durable' | 'transient'
  PRIMARY KEY (provider_id, model_id)
);
```

**Status is derived at read time, never stored** — a stored status is a
denormalization that goes wrong the first time a fetch is skipped:

| derived status | condition |
|---|---|
| `available` | listed in the most recent successful fetch for that provider |
| `unverified` | `in_catalog` but the provider does not implement `/models` (or its fetch has never succeeded) |
| `missing` | was fetched before, absent from the latest successful fetch → retired |
| `erroring` | `last_error_kind = 'durable'` and `last_error_at` is recent (see P1) |

`getModelsForProvider` returns enabled rows from this table.
`estimateCostUsd` reads the same rows and **returns `0` with a
`pricingKnown: false` flag** when `input_per_million IS NULL`, replacing the
Together-fallback. The cost line renders "—", not a wrong number.

`price_source` exists so P6's enrichment can never overwrite a curated or
user-set price. Precedence: `user` > `catalog` > `openrouter` > none.

### The roster comes free from the health probe

`checkProviderHealth` already fetches exactly the endpoint we need and discards
it. Change it to parse the body, hash the sorted id list, and **write only when
the hash changes** — a 30s poll that writes to SQLite every 30s is not
acceptable, one that writes on the rare weeks a provider ships is fine.

```
GET /models → ids
  hash = sha1(ids.sort().join())
  if hash !== providers.models_hash:
      upsert rows (fetched_at = now, last_seen_at = now, first_seen_at if new)
      mark absent rows as not-fetched-this-round
      providers.models_hash = hash, providers.models_fetched_at = now
```

Zero additional network requests, and the roster is at most 30s stale. This is
the single highest-leverage change in the plan and it is roughly fifteen lines.

Response shapes differ and each needs a small parser: OpenAI-compatible is
`{data:[{id}]}`, Anthropic is `{data:[{id, display_name}]}` (use `display_name`
as the label when the catalog has none), Ollama's `/v1/models` returns pulled
local models only.

`providers` gains `models_hash TEXT`, `models_fetched_at INTEGER`,
`last_health_status TEXT`, `last_health_at INTEGER` via `addColumnIfMissing`.
The last two exist so a cold boot starts from "was fine yesterday" rather than
blind — P1 depends on that.

### Files

| file | change |
|---|---|
| `engine/src/agent/catalog.json` | **new** — bundled catalog |
| `engine/src/agent/catalog.ts` | **new** — load bundled + `~/.rama/catalog.json`, merge, validate, typed accessors |
| `engine/src/agent/config.ts` | `MODEL_REGISTRY` deleted. `estimateCostUsd` reads `provider_models`, returns `{usd, pricingKnown}`. `DEFAULT_*` consts stay until P2 kills them. |
| `engine/src/db/schema.ts` | `provider_models` table |
| `engine/src/db/index.ts` | four `addColumnIfMissing` calls on `providers` |
| `engine/src/db/providerModels.ts` | **new** — upsert-from-fetch, upsert-from-catalog, list, derived status |
| `engine/src/providerHealth.ts` | parse + hash + conditional upsert |
| `engine/src/db/providers.ts` | `listProviders` reads models from the new table |
| `packages/protocol/src/index.ts` | `ModelInfo` grows `status`, `tier`, `pricing`, `supportsVision`, `deprecated`, `supersededBy` |

---

## Phase P1 — The composer picker only offers what works

**Decision (2026-09-06): hide, do not demote.** Models on a provider that is
erroring or missing its key do not appear in the picker at all. That is the
clean list the ask called for, and it costs three guards without which it
breaks in ordinary use. All three are requirements, not nice-to-haves.

### Guard 1 — `checking` counts as visible

`ProvidersProvider` starts every provider at `checking` and only resolves after
the first round-trip. A naive `status === "ok"` filter leaves the picker
**empty for the first second of every launch**, longer on a slow network,
forever when offline.

> Hide on `bad` and `no-key`. Show on `ok` and `checking`.

Plus: seed the boot state from `providers.last_health_status` (P0) instead of
`checking`, so a cold start opens with yesterday's known-good list already
rendered.

### Guard 2 — hysteresis, or the list dances

The probe runs every 30s. One flaky poll and a provider vanishes; the next poll
brings it back. Two rules:

- a provider is hidden only after **two consecutive** failed checks
- **the list never re-filters while the menu is open** — snapshot on open

A dropdown that reorders under the cursor is worse than a stale one.

### Guard 3 — the current chat's model is exempt

If a chat points at Anthropic and the key just died, the composer pill still has
to render something. The pill is **not** subject to the filter: it shows the
model id with a `--bad` dot and the word `unavailable`. Opening the picker puts
a banner *above* the list — `Anthropic — HTTP 401 · fix in settings →`,
deep-linking to that provider's card. The broken provider is not *in* the list;
it is in the header, because it is current state, not an offer.

### What the picker shows, in order

1. **Recent** — flat, the last 3–5 provider+model pairs actually used, no group
   headers. Cheapest large usability win available here; scanning four groups to
   re-pick the model you used five minutes ago is the current experience.
2. Healthy providers, `enabled = 1` models, grouped by provider.
3. Nothing else. Empty state is one row: `no providers connected — set one up →`.

Excluded: `missing` models unless currently selected, and `erroring` ones — the
next section defines what earns that.

### Per-model health, which provider health cannot give you

A provider can be `ok` while one model 403s: tier-gated OpenAI orgs, Anthropic
rate tiers, OpenRouter models the account has no credit for. You cannot know
until you try, so learn from the failures that actually happen. One write in
`loop.ts`'s catch block (`engine/src/agent/loop.ts:232`) sets `last_error`,
`last_error_at`, `last_error_kind` on the model row.

**Classify, or a rate limit will hide a model the user relies on:**

| kind | HTTP | effect |
|---|---|---|
| `durable` | 400, 401, 403, 404 model-not-found | model hidden, reason recorded, shown greyed in settings with the error |
| `transient` | 408, 409, 429, 5xx, network/abort | recorded for display only; **never** affects the filter |

A `durable` error also triggers an immediate roster re-fetch for that provider —
it is the strongest available signal that the roster is wrong.

### The cost of hiding, and where the signal goes instead

Hiding removes the only place the user would have noticed a provider broke. Two
surfaces become load-bearing and must land in this phase, not later:

- the status-bar dot (`rama-statusbar-dot` exists) goes amber/red on any
  configured provider being unhealthy, and is **clickable** through to that
  provider's card
- a count badge on the settings nav row, which also carries P4's "3 new models"

After P3's inversion, `no-key` stops meaning "never set up" and starts meaning
"the keychain lost your key" — new machine, keychain reset. That is rare and
loud; it belongs in the banner and the status bar, not quietly filtered away.

### Files

`apps/desktop/src/app/ModelPicker.tsx` (rewrite), `ProvidersProvider.tsx`
(consecutive-failure counter, last-known-status seeding),
`engine/src/agent/loop.ts` (error classification + record),
`engine/src/db/providerModels.ts` (`recordModelError`), status bar component,
`SettingsModal.tsx` (accept a deep-link target pane + provider id).

---

## Phase P2 — Model roles, and chats that name themselves

### Roles, not a "cheap model" setting

Do not add a `titleModel` setting. Title generation is the first of a queue:
context compaction, commit-message drafting, docs search-query rewriting,
auto-tagging, quick file summaries. Each one does not get its own settings row.

```sql
CREATE TABLE IF NOT EXISTS model_roles (
  role        TEXT PRIMARY KEY,   -- 'chat' | 'utility' | 'summarize'
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

- **`chat`** — the default for new chats. This **replaces `DEFAULT_PROVIDER_ID`
  and `DEFAULT_MODEL`** (`config.ts:8`) and is the S4 bullet, absorbed.
- **`utility`** — titles, tags, one-liners. Ships here.
- **`summarize`** — compaction. The slot is named now, wired when compaction
  lands. No UI row until then (rule 3).

**Defaulting.** On configuring a provider, if `utility` is unset, assign its
cheapest enabled `tier: "small"` model, preferring the provider that already
holds `chat` so nobody needs a second key to name a chat. `catalog.json`'s
per-provider `utilityModel` is the explicit hint.

The picks worth putting in the catalog as `tier: small`:

| provider | utility model | note |
|---|---|---|
| Groq | `llama-3.1-8b-instant` | best utility provider available; the whole product is latency, and 8B on Groq is ~free and instant |
| OpenAI | `gpt-4.1-nano` | **not** `gpt-4.1-mini`, which is what the registry has today. Nano is the right size for a six-word title. |
| Anthropic | `claude-haiku-4-5-20251001` | already in the registry |
| Together | an 8B-class Llama/Qwen | the registry currently lists only the 70B |
| OpenRouter | a `:free`-suffixed model | genuine zero-cost path |
| Ollama | any pulled model | free and private, but see the caveat below |

**The Ollama caveat, so it is not discovered in a bug report:** Ollama unloads a
model after ~5 minutes idle, so a cold utility call can take ten seconds. It is
therefore *not* the automatic default despite being free and private — it wins
only when the user picks it, and the row says why.

### Roles are an egress decision, not just a cost one

If chat runs on local Ollama and `utility` sits on OpenRouter, the user's prompt
just left the machine in order to name a chat. **The role row must state, in
plain words, which provider receives that traffic.** For the enterprise framing
this is the single most important sentence in the phase.

### Auto-titling

Today `createChat` writes `"new chat"` (`engine/src/db/chats.ts:77`) and nothing
ever changes it, so every chat in the sidebar has the same name.

Two-stage, and the first stage needs no model at all:

1. **Immediately** on the first user turn, set the title to the first ~40
   characters of that message. The sidebar is never full of `new chat` again
   even if every model call fails forever.
2. **After the first assistant run completes**, if the title is still the
   derived stub, ask the `utility` model for a real one.

Call discipline — this matters more than which model is chosen:

- hard **5s timeout**, **no retry**. A title is not worth a retry.
- no tools, `maxTokens: 24`, low temperature, single shot
- **fails silent**: no toast, no error event, no blocked send. The stub stands.
- skipped entirely when the utility provider's health is not `ok`
- fires **once per chat**; re-titling on topic drift is a follow-up, not v1
- usage recorded with `role='utility'` so the cost breakdown can separate it.
  Folding title tokens into the chat's cost line unmarked makes the whole cost
  display untrustworthy.
- one settings toggle, **`auto-name chats`**, and when it is off no content
  leaves for this purpose at all

New event: `{ type: "chat.renamed"; chatId: string; title: string }` in
`SessionEvent` — there is no chat-update event today
(`packages/protocol/src/index.ts:10`), so the sidebar has no way to learn about
the rename otherwise.

### Files

`engine/src/db/modelRoles.ts` (new), `engine/src/agent/utility.ts` (new — the
guarded one-shot call), `engine/src/agent/titling.ts` (new),
`engine/src/agent/loop.ts` (trigger after `run.finished`),
`engine/src/db/chats.ts` (stub title on first turn),
`engine/src/agent/config.ts` (delete the two consts),
`packages/protocol/src/index.ts` (`chat.renamed`, `ModelRoleDTO`),
`SettingsModal.tsx` (General: role rows + auto-name toggle).

---

## Phase P3 — A provider row means "the user configured this"

This is S5's inversion, unchanged in intent and pulled out as its own phase
because it is a destructive migration and should not ride along with UI work.

- **`seedProviders()` is deleted** (`engine/src/db/providers.ts:38`, called at
  `engine/src/db/index.ts:46`). The catalog file from P0 is what "Rama knows
  this exists" means now; the table holds only what has been set up.
- `providers` gains `is_custom`, `enabled`, `requires_key`, `auth_style`,
  `auth_header`, `extra_headers_json` via `addColumnIfMissing`. `requires_key`
  **must** be a column — `REQUIRES_KEY` (`providers.ts:34`) is keyed by seed id
  and silently answers `true` for anything custom.
- `loop.ts:97`'s `providerId !== "ollama"` becomes `providerRequiresKey()`,
  which is what unblocks keyless local endpoints (LM Studio, vLLM).

**Migration, run once:** keep a seeded row if the user has a keychain entry for
it **or** any chat references it; delete the rest. Short, safe, and nobody
re-enters anything. It runs against a real `~/.rama/rama.db` — test it on a copy
with a mix of configured, referenced and untouched seeds *before* it ships.

**Removal** needs a new Tauri command: `secrets.rs` has `set_provider_key` and
`get_provider_key` and **no delete**. Add `delete_provider_key`, plus
`DELETE /providers/:id` cascading `provider_models` and clearing any
`model_roles` row that pointed at it.

Chats pointing at a removed provider are **not** migrated and **not** deleted.
The picker shows the id as unavailable (P1's guard 3) and the chat cannot send
until it is repointed. Auto-migrating a chat to a different provider silently
changes what model its history was written by; one honest dead end beats that.

---

## Phase P4 — The providers pane, rewritten

A list of things you added, with an add button — the shape `mcp servers`
already has and the shape this pane should have copied from the start.

### Provider cards

Collapsed: status dot · label · base URL · `N models` · `default` badge.
Expanded: replace key, edit base URL, re-run health check, **the model list**,
re-fetch models, remove provider.

### The model list, and the filter

This is where a naive implementation dies. OpenRouter's `/models` is 300+
entries; OpenAI's ~50 including modalities nobody wants in a chat picker.
Presenting that raw is a *worse* experience than today's hardcoded three.

Default view is opinionated: catalog-known chat models only, typically 3–6, with
their tick state. Everything else lives behind
`show all 312 models from this provider`.

The expanded view is the filter the ask called for:

- **search** over id and label
- **capability toggles** — tools · thinking · vision
- **chat models only** (default on) — strips by id heuristic
  (`embed`, `whisper`, `tts`, `dall-e`, `rerank`, `moderation`) and by provider
  metadata where it exists
- **sort** — tier, then price, then name
- **snapshot collapsing** — `gpt-4.1-2025-04-14` folds under `gpt-4.1`; the
  alias is shown, the snapshot is available to pin
- status chips per row: `new`, `unverified`, `missing`, `erroring` with the
  recorded error text

Rows carry `+ add model manually` (sets `added_manually`, for fine-tunes and
private deployments) and, where `superseded_by` is set,
`→ Claude Sonnet 5 available` with a one-click switch. That is how "the latest
model" surfaces without the refresh ever touching the user's config.

**New models** arrive as a `new since you last looked` strip at the top of the
list plus the count badge on the nav row from P1 — with `enable` buttons, never
auto-enabled. **Missing models** stay in place, greyed,
`no longer offered — remove?`. The only case that earns a toast is a missing
model that is currently a chat's model or a role assignment.

### Fast-add

`+ add provider` for a catalog provider is **one field**: paste key → verify →
done, with `defaultEnabled` models silently ticked and a
`3 models enabled · change` line on the success row. This is roughly 80% of the
wizard's value for a fraction of P5, which is why it lands here and not there.

---

## Phase P5 — The wizard, and custom providers

The full flow, for the case fast-add cannot serve: a provider Rama has never
heard of.

Inline in the pane, **not a nested modal** — `Modal.tsx` does not stack, and a
modal inside Settings inside a window is one layer too many.

1. **Choose** — catalog tiles plus a `custom (OpenAI-compatible)` tile.
   Already-configured providers render as configured, not selectable twice.
2. **Credentials** — key (masked), base URL prefilled and editable. Custom adds
   display label and auth style: Bearer, or a named header. That is the whole
   realistic space; skip query-param auth.
3. **Verify** — the existing `providerHealth` check. Latency on success; the
   actual error text and a back button on failure. **Never finish on a failed
   check without an explicit "save anyway".** Silently saving a broken provider
   is how you get a mysterious failure three screens later.
4. **Models** — P4's list component, seeded from `GET /models`, falling back to
   the catalog when that 404s, falling back to typed ids when there is neither.
   At least one model enabled to finish.
5. **Finish** — `make this the default for new chats`, wired to P2's `chat` role.

First run, which is currently broken: the app boots with no keys and a default
provider that is not configured, into a chat that cannot send. First run routes
to this flow instead.

---

## Phase P6 — OpenRouter as a metadata oracle

**Decision (2026-09-06): yes, with guardrails.** OpenRouter's `/models` needs
**no API key** and returns pricing, context length, modality and
`supported_parameters` for hundreds of models across every vendor. It is the
best available answer to "how does pricing stay current without shipping a
release", and it fills `supports_tools` / `supports_thinking` for models the
catalog has never seen — which is exactly the custom-provider case.

Independent of P1–P5; it can land any time after P0.

Three guardrails, without which it produces confidently wrong numbers:

**1. It enriches, it never creates.** The oracle may only fill fields on rows
that already exist from a provider fetch. It must never add a selectable model —
otherwise OpenRouter's roster leaks models the user's Together key cannot serve
into their Together group. *Fetch decides existence* stays intact.

**2. Exact match or nothing.** Together's
`meta-llama/Llama-3.3-70B-Instruct-Turbo` and OpenRouter's
`meta-llama/llama-3.3-70b-instruct` are the same weights under different ids,
and fuzzy-matching between them is precisely how a wrong price gets displayed
with total confidence. Normalize (lowercase, strip vendor prefix), match
exactly, and carry an explicit `openrouterId` on curated catalog entries. No
match → no enrichment, and `estimateCostUsd` returns "no pricing" (P0).

**3. Mark the provenance.** OpenRouter's prices are *resale* prices with their
margin in them. An oracle-sourced number renders as `≈ $0.40/M` with a
"via OpenRouter" tooltip and `price_source = 'openrouter'`. Never launder a
third party's price into the provider's own, and never let it overwrite
`price_source` of `catalog` or `user`.

Mechanics: one unauthenticated GET, at most weekly, cached to
`~/.rama/catalog-cache.json` with a timestamp, never on the boot path, fails
silent, skipped entirely when there is nothing to enrich. One settings toggle,
because it is an outbound request and this is a local-first MIT app.

Side benefit: it is also the `superseded_by` feed — it knows a newer model
exists before Rama ships a release.

---

## Resolved questions

| # | question | phase | resolution |
|---|---|---|---|
| 1 | How does the catalog stay current between releases? | P0, P6 | **Local file + OpenRouter oracle.** Bundled `catalog.json` overlaid by `~/.rama/catalog.json`, enriched by an optional unauthenticated OpenRouter `/models` pull. Decided 2026-09-06. |
| 2 | Unreachable providers in the composer picker — hide or demote? | P1 | **Hide entirely.** Decided 2026-09-06, against the demote recommendation. Requires the three guards (`checking` visible, hysteresis, current-selection exempt) and moves the failure signal to the status bar and nav badge. |
| 3 | One flat `source` enum on a model row? | P0 | **No** — `in_catalog` / `fetched_at` / `added_manually` as independent fields. Catalog-known *and* fetch-confirmed is the healthy state and an enum cannot express it. |
| 4 | A dedicated "title model" setting? | P2 | **No** — a `model_roles` table. `chat`, `utility` now; `summarize` named, unwired. |
| 5 | Where does the default provider/model setting live? | P2 | The `chat` role. S4's bullet is absorbed; `DEFAULT_PROVIDER_ID`/`DEFAULT_MODEL` are deleted. |
| 6 | Extra network polling for the roster? | P0 | **None.** The 30s health probe already fetches `/models`; parse it, hash it, write on change. |

## Open questions

| # | question | phase | note |
|---|---|---|---|
| A | Does the `chat` role's provider need to be per-project rather than global? | P2 | A repo of Rust and a repo of docs plausibly want different defaults. Global now; `projects.settings_json` already exists if this proves needed. |
| B | Re-title on topic drift, or once per chat? | P2 | Once in v1. Drift detection needs a signal we do not have and a second utility call per chat. |
| C | Should `summarize` ship a UI row before compaction exists? | P2 | Currently no, per rule 3. Revisit when compaction lands. |

---

## Risks

1. **The P3 migration is destructive.** Deleting seeded rows on a real
   `~/.rama/rama.db`. Test on a copy containing a configured provider, a
   chat-referenced provider, and untouched seeds before it ships. Highest-risk
   item in the plan.
2. **Hiding hides the diagnosis too.** P1's status-bar dot and nav badge are not
   polish — without them, a dead key is invisible and the app just quietly has
   fewer models. They ship in P1 or P1 does not ship.
3. **Writing to SQLite on a 30s timer.** The hash guard in P0 is what makes the
   roster piggyback acceptable. If it is dropped during implementation, this
   becomes a write every 30s per provider, forever.
4. **Fuzzy id matching in P6.** The failure mode is a plausible-looking wrong
   price, which is worse than no price. Exact-match-or-nothing is not
   negotiable.
5. **A utility call that is not fully guarded** turns a background nicety into a
   visible hang on every new chat. Timeout, no retry, fail silent — all three.
6. **`ModelInfo` is in `packages/protocol`**, shared by engine and webview.
   Growing it is a cross-package change; land the protocol edit and both
   consumers in the same commit or the build breaks.

## Out of scope, named rather than silently absent

- **Azure OpenAI** (deployment name + `api-version`), **Bedrock** (SigV4),
  **Vertex** (service-account JSON). None fit the `openai-compatible` adapter;
  each is its own integration, not a catalog entry. For the enterprise framing
  these matter — as three follow-up projects.
- **Per-provider request timeouts** and retry policy. Small follow-up on the
  provider card.
- **Context compaction** — the `summarize` role's consumer.
- **Re-titling on topic drift** (open question B).
- **Per-project model defaults** (open question A).
- **Local model management** — pulling/removing Ollama models from inside Rama.
  Rama reads Ollama's roster; it does not manage it.

## Status 2026-10-15: Settings split into Providers and Models

The P4 pane and the P5 wizard are replaced, together with the rest of the settings modal, by a
kit-styled rebuild in `apps/desktop/src/app/settings/` (old `SettingsModal.tsx`,
`ProvidersSettingsPane.tsx` and `ProviderSetupWizard.tsx` are deleted).

- **Providers** has no catalog tiles. Every provider is added the same way: API format
  (OpenAI-compatible or Claude-compatible), base URL, optional key; "how the key is sent"
  (Bearer or a named header) sits under a disclosure for the OpenAI format only. The form checks
  the endpoint and hands over to Models. Rows open into name, base URL, key, health and Remove.
- **Models** is the shortlist across every provider ("In your menu", grouped by provider), an
  "Add models" list per provider (search, chat-models-only filter, dated snapshots folded, add by
  ID), and the chat/utility role defaults, which moved here from General.
- Home's "Choose a model" and the Code landing's no-provider card open Settings (the add form when
  there's no provider, Models otherwise) instead of embedding the wizard.

Engine changes that make this hold up without the tiles:

- `POST /providers/custom` takes `kind`. A typed endpoint that matches a catalog entry (same
  format, same normalized base URL) gets that catalog id while it's free
  (`catalogIdForEndpoint`), so catalog pricing, cache policy and the utility-model hint, all
  keyed by id, still apply. Anthropic-format URLs are stored without `/v1`.
- The Anthropic health probe uses the row's base URL (it was hard-coded to api.anthropic.com),
  and treats a 404 on `/v1/models` as reachable: gateways often implement only `/v1/messages`,
  and an unreachable provider is hidden from the picker (P1).
- A provider now starts with nothing ticked, so the role defaults (`maybeDefault*Role`) also run
  when a model is enabled or added. "Add by ID" on an id the roster already has enables it.
- Titling, complexity, instructions-init and the curator checked `providerId !== "ollama"` to
  allow keyless calls; they use `providerRequiresKey()` now, so any keyless local server works.

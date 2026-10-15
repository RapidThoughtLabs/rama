// Home fixtures — HOME_REDESIGN_PLAN.md §5 step 2, HD4/HD5. Layered on top of the Code fixture data
// (fixtures/code/build.ts) so both sections are populated, the way a real install would be.
//
//   /fixture.html?fixture=landing&theme=wakaba            the landing at 18:30, sidebar on Home
//   …?fixture=landing-model-pop                           with the model menu open
//   …?fixture=landing-web-on                              with Web search pressed
//   …?fixture=landing-cloud-model                         with GLM 5.3 Flash (cloud) as the draft model
//   &model=qwen|gemma|glm|sonnet                          any fixture: the draft's starting model
//   &providers=none                                       first run: no providers, no Home chats
//
// The ten chats are the mockup's CHATS (mock:L882-1004). Their updatedAt values are chosen so the
// app's own date grouping and relative times reproduce the mockup's labels against the frozen
// clock: Today ("2 hours ago", "5 hours ago", "This morning"), Yesterday, Previous 7 days and
// September. Snippets are the mockup's (the engine derives them from the last reply).
//
// HD6 — every chat has its transcript (transcripts.ts), and each opens as a fixture of its own:
//   …?fixture=chat-lease | chat-lisbon | chat-bill | chat-<any chat id>
//   …?fixture=chat-working                                a run that hasn't written anything yet
// Chat fixtures open at the top of the transcript (D4's open-at-bottom is for real use), and
// chat-lisbon opens with its web search row expanded.

import type { HomeChatSummaryDTO, ProviderDTO } from "@rama/protocol";
import { FIXTURE_NOW } from "../code/mockupData";
import type { FixtureData } from "../mockEngine";
import { TRANSCRIPTS, buildTranscript } from "./transcripts";

const CHAT_IDS = ["lease", "lisbon", "bill", "sourdough", "school", "recipe", "index", "plant", "toast", "phone"];

export const HOME_FIXTURES = [
  "landing",
  "landing-model-pop",
  "landing-web-on",
  "landing-cloud-model",
  "chat-working",
  ...CHAT_IDS.map((id) => `chat-${id}`),
];

/** The mockup's four Home models (mock:L868-873) as provider/model ids. */
const MODELS = {
  qwen: { providerId: "ollama", modelId: "qwen3:14b" },
  gemma: { providerId: "lmstudio", modelId: "gemma-3-12b" },
  glm: { providerId: "together", modelId: "zai-org/GLM-5.3-Flash" },
  sonnet: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
} as const;
type ModelKey = keyof typeof MODELS;

const at = (day: number, h: number, m = 0) => new Date(2026, day < 0 ? 8 : 9, day < 0 ? -day : day, h, m).getTime(); // negative day = September

const CHATS: { id: string; title: string; model: ModelKey; updatedAt: number; snippet?: string }[] = [
  { id: "lease", title: "Lease review before Friday", model: "qwen", updatedAt: FIXTURE_NOW - 2 * 3_600_000, snippet: "Three clauses are worth raising before you sign." },
  { id: "lisbon", title: "Lisbon in March", model: "glm", updatedAt: FIXTURE_NOW - 5 * 3_600_000, snippet: "Highs around 18 °C, and a plan that takes the city one area at a time." },
  { id: "bill", title: "Splitting the electricity bill", model: "qwen", updatedAt: at(5, 9, 10), snippet: "A spreadsheet formula that splits it by room size." },
  { id: "sourdough", title: "Why my sourdough collapses", model: "gemma", updatedAt: at(4, 20, 15) },
  { id: "school", title: "Note to the school about pickups", model: "qwen", updatedAt: at(4, 11, 40) },
  { id: "recipe", title: "Grandma's recipe card, in English", model: "sonnet", updatedAt: at(2, 19) },
  { id: "index", title: "Index funds, explained simply", model: "glm", updatedAt: at(1, 10) },
  { id: "plant", title: "A first houseplant for a dim flat", model: "qwen", updatedAt: at(-29, 15) },
  { id: "toast", title: "Birthday toast for my sister", model: "sonnet", updatedAt: at(-20, 18) },
  { id: "phone", title: "Two phone plans, compared", model: "glm", updatedAt: at(-14, 12) },
];

function lmStudio(ollama: ProviderDTO): ProviderDTO {
  return {
    ...ollama,
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    models: [{ ...ollama.models[0]!, id: MODELS.gemma.modelId, label: "Gemma 3 12B" }],
  };
}

export function applyHomeFixture(name: string, params: URLSearchParams, data: FixtureData): void {
  // The Code fixture now lists LM Studio itself (code/build.ts); add it only if it's missing, or
  // the model menu shows Gemma twice and grows too tall to open above the landing composer.
  const ollama = data.providers.find((p) => p.id === "ollama")!;
  if (!data.providers.some((p) => p.id === "lmstudio")) data.providers.push(lmStudio(ollama));

  data.homeChats = CHATS.map(
    (c): HomeChatSummaryDTO => ({
      id: c.id,
      projectId: "home",
      kind: "home",
      title: c.title,
      backend: { kind: "own-loop" },
      providerId: MODELS[c.model].providerId,
      model: MODELS[c.model].modelId,
      mode: "agent",
      agentId: "home",
      themeId: "wakaba",
      status: "idle",
      costUsd: 0,
      utilityCostUsd: 0,
      contextUsed: 0,
      contextMax: 0,
      createdAt: c.updatedAt - 10 * 60_000,
      updatedAt: c.updatedAt,
      snippet: c.snippet ?? null,
      webSearch: c.id === "lisbon",
    }),
  );

  for (const c of CHATS) {
    const t = buildTranscript(c.id, TRANSCRIPTS[c.id] ?? [], MODELS[c.model], c.updatedAt);
    data.messages[c.id] = t.messages;
    data.toolCalls[c.id] = t.toolCalls;
  }
  // A run that has started but not written anything yet: the lease chat's first question, and the
  // engine's opening events replayed on subscribe.
  if (name === "chat-working") {
    data.messages.lease = data.messages.lease!.slice(0, 1);
    data.toolCalls.lease = [];
    data.liveEvents.lease = [
      { type: "run.started", runId: "fixture-run", ts: FIXTURE_NOW },
      { type: "status", state: "thinking", verb: "thinking" },
    ];
  }

  const key = (params.get("model") ?? (name === "landing-cloud-model" ? "glm" : "qwen")) as ModelKey;
  const draftModel = MODELS[key] ?? MODELS.qwen;
  data.modelRoles = { chat: { role: "chat", providerId: draftModel.providerId, modelId: draftModel.modelId, updatedAt: 0 } };

  if (params.get("providers") === "none") {
    data.providers = [];
    data.modelRoles = {};
    data.homeChats = [];
  }

  window.localStorage.setItem("rama.nav.main", JSON.stringify({ section: "home", sidebarOpen: params.get("sb") !== "closed" }));

  // States the landing only reaches through a click, made once the app has mounted.
  const click = name === "landing-model-pop" ? ".r-landing .r-model-pill" : name === "landing-web-on" ? ".r-landing .r-tool-btn[aria-pressed]" : null;
  if (click) void clickWhenReady(click);

  if (name.startsWith("chat-")) {
    const id = name === "chat-working" ? "lease" : name.slice("chat-".length);
    const chat = CHATS.find((c) => c.id === id);
    if (!chat) throw new Error(`[fixture] no Home chat "${id}"`);
    void openChatWhenReady(chat.title, id === "lisbon" && name !== "chat-working");
  }
}

/** Opens a Home chat the way a person would (its sidebar row), then shows the top of it. */
async function openChatWhenReady(title: string, expandFirstAct: boolean): Promise<void> {
  const row = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(".r-chat-row")).find((r) => r.textContent?.trim() === title));
  if (!row) return console.warn(`[fixture] never found the "${title}" row`);
  await new Promise((r) => setTimeout(r, 400));
  Array.from(document.querySelectorAll<HTMLElement>(".r-chat-row")).find((r) => r.textContent?.trim() === title)?.click();
  const turn = await waitFor(() => document.querySelector(".r-home-chat .r-turn-ai"));
  if (!turn) return console.warn("[fixture] the chat never rendered a reply");
  await new Promise((r) => setTimeout(r, 150));
  if (expandFirstAct) document.querySelector<HTMLElement>(".r-home-chat .r-act-btn")?.click();
  await new Promise((r) => setTimeout(r, 50));
  const scroller = document.querySelector<HTMLElement>(".r-home-chat .r-scroller");
  if (scroller) scroller.scrollTop = 0;
}

async function waitFor<T>(find: () => T | null | undefined): Promise<T | null> {
  for (let i = 0; i < 200; i++) {
    const v = find();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function clickWhenReady(selector: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const el = document.querySelector<HTMLElement>(selector);
    // The model menu needs the providers loaded, or it opens empty. Then let boot settle (the tree
    // remounts once while the providers resolve, losing an earlier click) and finish the arrival:
    // the menu measures the pill where it is at that moment, and a hidden window never advances
    // the animation on its own.
    if (el && document.querySelector(".r-landing .r-model-pill svg")) {
      await new Promise((r) => setTimeout(r, 400));
      document.getAnimations().forEach((a) => a.finish());
      document.querySelector<HTMLElement>(selector)?.click();
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  console.warn(`[fixture] never found ${selector}`);
}

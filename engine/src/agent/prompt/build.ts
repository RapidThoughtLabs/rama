import { createHash } from "node:crypto";
import type { ChatKind, ChatMode } from "@rama/protocol";
import type { WireMessage } from "../../llm/types";
import type { RamaToolSet } from "../../tools/define";
import type { AgentDef } from "../agents/types";
import type { CachePolicy } from "../catalog";
import { buildAgentBlock } from "./agent";
import { formatEffectiveToolsNote } from "./effectiveToolsNote";
import { HOME_KERNEL_PROMPT, KERNEL_PROMPT } from "./kernel";
import { buildModeBlock } from "./mode";
import { formatProjectKnowledge, type ProjectKnowledgeInputs } from "./project";
import { formatStaticEnv, type StaticEnv } from "./sources";
import { generateToolInventory } from "./toolInventory";

// docs/PROMPT_STACK_PLAN.md Phase PS0/PS1/PS2/PS3/PS4 — the assembly seam. Pure and synchronous:
// every input is already fetched by the caller (loop.ts), nothing here does I/O or touches the
// DB, and the same inputs always produce the same bytes (asserted by build.test.ts). §4.2's
// breakpoint layout: block 1 is bp1 (tools+kernel — deliberately NOT narrowed by agent/mode;
// loop.ts narrows the separate `tools` object it hands to streamText, so switching agent never
// touches this block), block 2 is bp2 (agent + mode + project + static env, merged into one block
// per docs/CONTEXT_BUDGET_PLAN.md CB5/D5 — these all change at the same frequency (per chat, per
// project), so splitting them into separate breakpoints was never buying a partial hit, only
// spending two of Anthropic's 4-breakpoint budget. CB5 spends the freed slot on a second
// conversation-tail cache anchor instead). bp3/bp4 are the two conversation-tail anchors, marked
// by transcript.ts's project().
export interface PromptInputs {
  /** HOME_REDESIGN_PLAN.md Phase HD3 — a Home chat gets HOME_KERNEL_PROMPT and skips the mode and
   *  project blocks (no RAMA.md, no mode authority text: Home has neither). Defaults to "code". */
  kind?: ChatKind;
  /** Already sorted by name (toolInventory.ts's sortTools) — every tool the harness has, NOT
   *  narrowed by mode/agent. bp1's inventory is a stable build-level capability list on purpose
   *  (§4.2: "switching agent ... keeps tools+kernel warm"); `effectiveToolNames` below is what's
   *  actually callable this turn, and the caller passes that same narrower set to streamText. */
  tools: RamaToolSet;
  /** heku's buildManifest() output, "" when nothing is connected. */
  hekuManifest: string;
  staticEnv: StaticEnv;
  cache: CachePolicy;
  mode: ChatMode;
  agent: AgentDef;
  /** Names of the tools actually passed to streamText this turn (after mode/agent narrowing) —
   *  see effectiveToolsNote.ts for why this is separate from `tools` above. */
  effectiveToolNames: string[];
  projectKnowledge: ProjectKnowledgeInputs;
}

export interface PromptBlock {
  label: string;
  content: string;
  cached: boolean;
}

export interface PromptBlocks {
  system: WireMessage[];
  /** Same content as `system`, annotated for the prompt-preview route and tests. */
  blocks: PromptBlock[];
  /** Stable hash of the assembled content — two calls with identical inputs hash identically. */
  hash: string;
}

export function buildPrompt(inputs: PromptInputs): PromptBlocks {
  const cached = inputs.cache.style === "explicit";

  const home = inputs.kind === "home";
  const kernelContent = [home ? HOME_KERNEL_PROMPT : KERNEL_PROMPT, generateToolInventory(inputs.tools), inputs.hekuManifest]
    .filter(Boolean)
    .join("\n\n");
  const toolsNote = formatEffectiveToolsNote(inputs.effectiveToolNames, Object.keys(inputs.tools));
  const agentModeProjectContent = [
    buildAgentBlock(inputs.agent),
    home ? "" : buildModeBlock(inputs.mode),
    toolsNote,
    formatStaticEnv(inputs.staticEnv),
    home ? "" : formatProjectKnowledge(inputs.projectKnowledge),
  ]
    .filter(Boolean)
    .join("\n\n");

  const blocks: PromptBlock[] = [
    { label: "kernel+tools", content: kernelContent, cached },
    { label: "agent+mode+project+env", content: agentModeProjectContent, cached },
  ];

  const system: WireMessage[] = blocks.map((b) => ({
    role: "system" as const,
    content: b.content,
    annotations: b.cached ? { cacheBreakpoint: true } : undefined,
  }));

  const hash = createHash("sha1")
    .update(blocks.map((b) => b.content).join("\x00"))
    .digest("hex");
  return { system, blocks, hash };
}

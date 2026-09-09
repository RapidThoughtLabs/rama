import type { RamaTool, RamaToolSet } from "../../tools/define";

// docs/PROMPT_STACK_PLAN.md Phase PS0 — layer 0, "rendered as tools (sorted by name)". Every
// caller that builds the final tool map for a run must push it through this before it reaches
// either streamText's `tools` option or generateToolInventory below, so the wire schemas and the
// prose inventory the model reads are always the same set in the same order — never two
// independently-maintained lists that can drift apart.
export function sortTools<T extends RamaToolSet>(tools: T): T {
  const out: RamaToolSet = {};
  for (const name of Object.keys(tools).sort()) out[name] = tools[name];
  return out as T;
}

function describeTool(name: string, entry: RamaTool): string {
  const description = typeof entry.description === "string" ? entry.description : "";
  return `- ${name}: ${description}`;
}

// Replaces config.ts's old hardcoded "you have eight tools: read, write, ..." sentence, which
// drifted from reality the moment a tool was added without also editing that string by hand (it
// never mentioned process, browser, or any skill_* tool). Built from the exact RamaToolSet passed to
// streamText, so it cannot drift again.
export function generateToolInventory(tools: RamaToolSet): string {
  const names = Object.keys(tools);
  const lines = names.map((name) => describeTool(name, tools[name] as RamaTool));
  return `You have ${names.length} tool${names.length === 1 ? "" : "s"} this turn:\n${lines.join("\n")}`;
}

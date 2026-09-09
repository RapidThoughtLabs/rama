// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — "/init drafts one by reading the repo. It is a
// one-shot, and one-shots go stale." Deliberately shallow (package.json + README + a top-level
// listing, not a repo crawl): this produces a starting draft the user edits, not a final answer.
// Mirrors agent/titling.ts's utility-role call shape, but returns its result to an awaiting HTTP
// caller instead of firing-and-forgetting — an explicit user action should surface a real failure
// rather than silently doing nothing. Never writes anything: decision 6 (§6.2) means a draft only
// ever reaches disk through instructions.ts's setProjectInstructions, called after the user
// accepts it via the PUT endpoint.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { complete } from "../llm/complete";
import { getProvider } from "../db/providers";
import { getSecret } from "../secrets";
import { getUtilityTarget } from "./utility";

const INIT_TIMEOUT_MS = 20_000;
const INIT_SYSTEM_PROMPT =
  "Draft a concise RAMA.md for this project from the signals below: package manager and real " +
  "commands (build/test/lint), directory layout, and anything a coding agent would otherwise get " +
  "wrong on the first try. Markdown, headers, under 100 lines. Output only the file content — no " +
  "preamble, no code fence.";

function readIfExists(path: string, maxChars: number): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").slice(0, maxChars);
  } catch {
    return null;
  }
}

function gatherSignals(projectPath: string): string {
  const parts: string[] = [];
  const pkg = readIfExists(join(projectPath, "package.json"), 4000);
  if (pkg) parts.push(`package.json:\n${pkg}`);
  for (const name of ["README.md", "readme.md"]) {
    const readme = readIfExists(join(projectPath, name), 4000);
    if (readme) {
      parts.push(`${name}:\n${readme}`);
      break;
    }
  }
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    parts.push(`top-level entries:\n${entries.join("\n")}`);
  } catch {
    // unreadable directory — the model gets whatever else was gathered above
  }
  return parts.join("\n\n---\n\n");
}

export type DraftResult = { ok: true; content: string } | { ok: false; error: string };

export async function draftProjectInstructions(projectPath: string): Promise<DraftResult> {
  const target = getUtilityTarget();
  if (!target) return { ok: false, error: "no utility model configured — set one in settings" };

  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow) return { ok: false, error: `unknown provider "${target.providerId}"` };
  if (!apiKey && target.providerId !== "ollama") {
    return { ok: false, error: `no ${providerRow.label ?? target.providerId} key configured` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);
  try {
    const result = await complete(
      providerRow,
      target.model,
      apiKey,
      [{ role: "user", content: gatherSignals(projectPath) }],
      controller.signal,
      {
        system: INIT_SYSTEM_PROMPT,
        maxOutputTokens: 800,
        temperature: 0.2,
      }
    );
    const content = result.text.trim();
    if (!content) return { ok: false, error: "the model returned an empty draft" };
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

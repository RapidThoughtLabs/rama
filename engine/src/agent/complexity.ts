// docs/PROMPT_STACK_PLAN.md §8.1, Phase PS6 — the complexity classifier. "Most of the signal is
// not even model-shaped: message length, count of distinct requirements, named-but-nonexistent
// files, 'and also'." Open question D's leaning ("threshold first, model second") is the whole
// shape of this module: cheap, pure, synchronous signals decide the obvious cases for free;
// the `utility` role (mirrors titling.ts exactly — same timeout, same fail-silent-to-a-default)
// only gets called for the genuinely ambiguous middle.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { complete } from "../llm/complete";
import { recordUtilityUsage } from "../db/chats";
import { getProvider } from "../db/providers";
import { getSecret } from "../secrets";
import { estimateCostUsd } from "./config";
import { getUtilityTarget } from "./utility";

export type TaskComplexity = "trivial" | "normal" | "complex";

const CLASSIFY_TIMEOUT_MS = 5000;
const LONG_MESSAGE_CHARS = 800;
const SHORT_MESSAGE_CHARS = 200;

// Bullets, numbered lines, and the two connector phrases §8.1 calls out by name — a conservative
// set chosen to avoid false positives ("also" alone matches far too much ordinary prose).
const REQUIREMENT_MARKER_RES = [/\n[ \t]*[-*][ \t]+/g, /\n[ \t]*\d+[.)][ \t]+/g, /\band also\b/gi, /\badditionally\b/gi, /;[ \t]/g];

// A path-like token: contains a "/" (a real path fragment) or ends in a common code/doc
// extension. Filters out version numbers ("v2.0"), decimals, and similar noise that a bare
// `\w+\.\w+` pattern would otherwise catch.
const PATH_TOKEN_RE = /\b[\w][\w./-]*\.(?:[a-zA-Z]{1,10})\b|\b[\w][\w/-]*\/[\w./-]+\b/g;
const CODE_EXTENSION_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|c|cpp|h|hpp|cs|swift|kt|md|json|ya?ml|css|html|sql|sh)$/i;

export interface ComplexitySignals {
  length: number;
  requirementMarkers: number;
  missingFiles: string[];
}

// Pure given the filesystem's current state — same category of "sync fs read" as
// instructions.ts's project-knowledge lookups. No network, no model.
export function gatherComplexitySignals(text: string, projectPath: string): ComplexitySignals {
  const requirementMarkers = REQUIREMENT_MARKER_RES.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);

  const candidates = new Set(text.match(PATH_TOKEN_RE) ?? []);
  const missingFiles: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.includes("/") && !CODE_EXTENSION_RE.test(candidate)) continue;
    if (/^https?:/.test(candidate)) continue;
    const abs = isAbsolute(candidate) ? candidate : join(projectPath, candidate);
    if (!existsSync(abs)) missingFiles.push(candidate);
  }

  return { length: text.length, requirementMarkers, missingFiles };
}

// score: length + requirement markers + missing-file mentions, each capped so no single signal
// dominates. Two clean bands (trivial, complex) resolve without a model call; everything between
// them is "borderline" and gets escalated.
function scoreSignals(signals: ComplexitySignals): number {
  const lengthPoints = signals.length > LONG_MESSAGE_CHARS ? 1 : 0;
  const markerPoints = Math.min(signals.requirementMarkers, 3);
  const missingFilePoints = Math.min(signals.missingFiles.length, 2);
  return lengthPoints + markerPoints + missingFilePoints;
}

export function classifyByHeuristic(signals: ComplexitySignals): TaskComplexity | "borderline" {
  const score = scoreSignals(signals);
  if (score === 0 && signals.length < SHORT_MESSAGE_CHARS) return "trivial";
  if (score >= 3) return "complex";
  return "borderline";
}

const CLASSIFY_SYSTEM_PROMPT =
  'Classify how complex the user\'s coding request is. Reply with exactly one word, either "normal" or ' +
  '"complex" — nothing else. "complex" means it has multiple distinct requirements, or genuine ambiguity ' +
  "where different reasonable interpretations would produce materially different work. \"normal\" means " +
  "it's a single, reasonably well-scoped task, even one that takes real effort.";

// Fails silent to "normal" by design, same as maybeTitleChat's stub-stands rule: a missed
// classification should never block or visibly disrupt a turn, only skip the nudge it would
// have added.
async function classifyByModel(chatId: string, text: string): Promise<TaskComplexity> {
  const target = getUtilityTarget();
  if (!target) return "normal";

  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow || (!apiKey && target.providerId !== "ollama")) return "normal";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const result = await complete(
      providerRow,
      target.model,
      apiKey,
      [{ role: "user", content: text.slice(0, 4000) }],
      controller.signal,
      {
        system: CLASSIFY_SYSTEM_PROMPT,
        maxOutputTokens: 8,
        temperature: 0,
      }
    );

    const { usd } = estimateCostUsd(target.providerId, target.model, result.usage.inputTokens, result.usage.outputTokens);
    recordUtilityUsage(chatId, usd);

    return result.text.trim().toLowerCase().startsWith("complex") ? "complex" : "normal";
  } catch {
    return "normal";
  } finally {
    clearTimeout(timeout);
  }
}

// The public entry point loop.ts calls, once, only on a chat's first user turn.
export async function classifyComplexity(chatId: string, text: string, projectPath: string): Promise<TaskComplexity> {
  const heuristic = classifyByHeuristic(gatherComplexitySignals(text, projectPath));
  if (heuristic !== "borderline") return heuristic;
  return classifyByModel(chatId, text);
}

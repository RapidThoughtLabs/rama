import type { ToolCallDTO } from "@rama/protocol";
import type { IconName } from "@rama/ui";

/* Home's plain-language activity rows — HOME_REDESIGN_PLAN.md Phase HD6, the mapping table. A tool
   call or a thinking block becomes an icon, a label, an optional meta and a body, in words a
   person would use. Tool names never reach Home's UI. Pure, so it's unit-tested
   (actLabels.test.ts). */

export type ActBody = { kind: "text"; text: string } | { kind: "list"; items: { title: string; source?: string }[] } | null;

export interface Act {
  icon: IconName;
  label: string;
  meta?: string;
  metaBad?: boolean;
  body: ActBody;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Thought for 6 seconds", "Thought for a moment" under a second, "Thought it through" when the
 *  duration wasn't kept. */
export function thinkingAct(text: string, durationMs: number | undefined): Act {
  let label = "Thought it through";
  if (durationMs != null) {
    const s = Math.round(durationMs / 1000);
    label = s < 1 ? "Thought for a moment" : `Thought for ${plural(s, "second")}`;
  }
  return { icon: "clock", label, body: text.trim() ? { kind: "text", text: text.trim() } : null };
}

/** The live row while the model is still thinking: "Thinking" with the seconds so far. */
export function liveThinkingAct(text: string, elapsedMs: number): Act {
  return { icon: "clock", label: "Thinking", meta: plural(Math.max(0, Math.floor(elapsedMs / 1000)), "second"), body: text.trim() ? { kind: "text", text: text.trim() } : null };
}

interface ReadInput {
  path?: string;
  offset?: number;
  limit?: number;
}
interface WebInput {
  query?: string;
  url?: string;
}
interface ClarifyInput {
  questions?: { question?: string }[];
}

function asObject<T>(input: unknown): T {
  return (input && typeof input === "object" ? input : {}) as T;
}

/** A tool call as a row. `toolCall.ok === null` means it's still running. */
type CallLike = Pick<ToolCallDTO, "name" | "input" | "ok" | "resultSummary"> & Pick<Partial<ToolCallDTO>, "resultMeta">;

export function toolAct(call: CallLike): Act {
  const act = describeTool(call);
  if (call.ok === false) {
    return { ...act, meta: "didn't work", metaBad: true, body: { kind: "text", text: call.resultSummary?.trim() || "Something went wrong." } };
  }
  return act;
}

function describeTool({ name, input, resultSummary, resultMeta }: CallLike): Act {
  const summary = resultSummary ?? "";
  if (name === "read") {
    const { path = "", offset } = asObject<ReadInput>(input);
    const file = baseName(path) || "a file";
    if (IMAGE_EXT.test(path)) return { icon: "image", label: `Looked at ${file}`, body: { kind: "text", text: `Looked at ${file} on this Mac.` } };
    // read's summary: "1-200 of 340 lines" (engine/src/tools/read.ts).
    // A PDF's summary carries its page count instead (HD7).
    const pages = summary.match(/(\d+) pages?/);
    if (pages) return { icon: "doc", label: `Read ${file}`, meta: plural(Number(pages[1]), "page"), body: { kind: "text", text: `Read ${file} on this Mac.` } };
    const m = summary.match(/^(\d+)-(\d+) of (\d+) lines?/);
    const total = m ? Number(m[3]) : undefined;
    const whole = m ? Number(m[1]) === 1 && Number(m[2]) === total : !offset;
    const text = m && !whole ? `Read lines ${m[1]}–${m[2]} of ${file}, on this Mac.` : `Read the whole of ${file}, on this Mac.`;
    return { icon: "doc", label: `Read ${file}`, meta: total != null ? plural(total, "line") : undefined, body: { kind: "text", text } };
  }
  if (name === "clarify") {
    const { questions = [] } = asObject<ClarifyInput>(input);
    const items = questions.map((q) => ({ title: q.question ?? "" })).filter((q) => q.title);
    return { icon: "ask", label: "Asked you a question", body: items.length ? { kind: "list", items } : null };
  }
  if (name.startsWith("web")) {
    const { url, query } = asObject<WebInput>(input);
    if (url) return { icon: "globe", label: `Read ${hostOf(url)}`, body: { kind: "text", text: url } };
    const sources = Array.isArray(resultMeta?.sources) ? (resultMeta.sources as { title?: string; source?: string }[]).filter((x) => x?.title) : [];
    const n = sources.length || Number(summary.match(/(\d+) (?:results?|sources?)/)?.[1] ?? 0);
    return {
      icon: "globe",
      label: "Searched the web",
      meta: n ? plural(n, "source") : undefined,
      body: sources.length
        ? { kind: "list", items: sources.map((x) => ({ title: x.title!, source: x.source })) }
        : query
          ? { kind: "text", text: `Searched for “${query}”.` }
          : null,
    };
  }
  return { icon: "tool", label: "Used a tool", body: summary ? { kind: "text", text: summary } : null };
}

/** What the working line says while a tool runs, in the present tense. */
export function workingVerb(call: Pick<ToolCallDTO, "name" | "input">): string {
  if (call.name === "read") {
    const { path = "" } = asObject<ReadInput>(call.input);
    const file = baseName(path) || "a file";
    return IMAGE_EXT.test(path) ? `Looking at ${file}` : `Reading ${file}`;
  }
  if (call.name === "clarify") return "Asking you a question";
  if (call.name.startsWith("web")) {
    const { url } = asObject<WebInput>(call.input);
    return url ? `Reading ${hostOf(url)}` : "Searching the web";
  }
  return "Working on it";
}

/** mock's whale verbs, cycled every 2s while the engine reports thinking. */
export const WHALE_VERBS = ["Diving in", "Surfacing", "Swimming through it", "Taking a breath", "Charting a course"];

/** A failed run as one plain sentence for the notice under the transcript, never raw error text
 *  beyond its first line. */
export function errorSentence(message: string | null): string {
  const first = (message ?? "").split("\n")[0]!.trim();
  if (/\bkey\b/i.test(first)) return "This model needs an API key. Add one in Settings, then try again.";
  if (/ECONNREFUSED|fetch failed|connect|unreachable|network/i.test(first)) return "Couldn't reach the model. Check that it's running, then try again.";
  if (/\b429\b|rate.?limit|overloaded|busy/i.test(first)) return "The model is busy right now. Give it a moment, then try again.";
  if (!first) return "Something went wrong with that reply.";
  return `Something went wrong with that reply: ${first.length > 140 ? `${first.slice(0, 139)}…` : first}`;
}

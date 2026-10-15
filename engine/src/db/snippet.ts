// HOME_REDESIGN_PLAN.md Phase HD3 — the Home sidebar's one-line preview of a chat: the first
// sentence of the last assistant reply, as plain text. Pure, so it's unit-tested without a DB.

export const SNIPPET_MAX = 140;

export function snippetFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    // Fenced blocks (code, drafts) aren't prose — drop them whole, closed or still streaming.
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    // Table rows and divider lines.
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    // Images go entirely; links keep their text.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Line-leading markers: headings, quotes, bullets, numbers.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    // Inline code keeps its content; emphasis markers go.
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;

  const sentence = plain.match(/^.*?[.!?…](?=\s|$)/)?.[0] ?? plain;
  if (sentence.length <= SNIPPET_MAX) return sentence;
  const cut = sentence.slice(0, SNIPPET_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SNIPPET_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** What a pending permission request would do, as the end of "Waiting for your OK to …" (mock:L1341).
 *  Mirrors the ask card's own wording (apps/desktop/src/app/code/transcript/permissionCopy.ts) in the
 *  few words a one-line row has room for. */
export function waitingVerb(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as { op?: string; action?: string };
  switch (tool) {
    case "bash":
    case "process":
      return "run a command";
    case "edit":
      return "edit a file";
    case "write":
      return "write a file";
    case "file_op":
      return "change your files";
    case "git_write":
      return (
        { commit: "commit", stage: "stage files", unstage: "unstage files", restore: "discard changes", branch: "create a branch", checkout: "switch branch", stash: "stash your changes" }[i.op ?? ""] ??
        "change git"
      );
    case "browser":
      return "use the browser";
    default:
      return "continue";
  }
}

export function waitingSnippet(tool: string, input: unknown): string {
  return `Waiting for your OK to ${waitingVerb(tool, input)}.`;
}

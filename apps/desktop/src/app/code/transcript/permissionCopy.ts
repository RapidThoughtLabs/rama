import type { Seg } from "./rows";
import { hostOf } from "./rows";

/* What a permission request says — docs/CODE_REDESIGN_PLAN.md CR7 (mock:L451-461, 1709-1714): a
   question a person can answer, the literal action, and a sentence about what yes means. The old
   card showed the tool name and its raw input. Pure, so it is unit-tested (permissionCopy.test.ts). */

export interface AskCopy {
  title: string;
  /** The literal action: a command, a path, a URL. */
  code?: string;
  body: Seg[];
}
export interface AskContext {
  /** Where the project lives, as shown to a person (`~/code/rama`). */
  cwd?: string;
  branch?: string | null;
  /** Files with uncommitted changes, for the commit sentence. */
  changedCount?: number | null;
  terminalTitle?: (id: string) => string | undefined;
}

const obj = <T,>(input: unknown): T => (input && typeof input === "object" ? input : {}) as T;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lineCount = (s: string) => (s ? s.split("\n").length : 0);

export function permissionCopy(tool: string, input: unknown, ctx: AskContext = {}): AskCopy {
  switch (tool) {
    case "bash": {
      const i = obj<{ command?: string; background?: boolean }>(input);
      const where = ctx.cwd ? ctx.cwd : "the project folder";
      return {
        title: "Run this command?",
        code: i.command ?? "",
        body: [`It runs in ${where} on this Mac.${i.background ? " It keeps running after you say yes, until you stop it." : ""}`],
      };
    }
    case "edit": {
      const i = obj<{ path?: string; edits?: { oldString?: string; newString?: string }[] }>(input);
      const added = (i.edits ?? []).reduce((n, e) => n + lineCount(e.newString ?? ""), 0);
      const removed = (i.edits ?? []).reduce((n, e) => n + lineCount(e.oldString ?? ""), 0);
      return { title: `Edit ${base(i.path ?? "") || "this file"}?`, code: i.path, body: [`About +${added} −${removed} lines in your working tree. You can undo it afterwards.`] };
    }
    case "write": {
      const i = obj<{ path?: string; content?: string }>(input);
      return { title: `Write ${base(i.path ?? "") || "this file"}?`, code: i.path, body: [`${plural(lineCount(i.content ?? ""), "line")} written to your working tree. You can undo it afterwards.`] };
    }
    case "file_op": {
      const i = obj<{ op?: string; from?: string; to?: string; path?: string }>(input);
      if (i.op === "remove") return { title: `Delete ${base(i.path ?? "")}?`, code: i.path, body: ["It's removed from your working tree. You can undo it afterwards."] };
      if (i.op === "move" || i.op === "copy") return { title: `${i.op === "move" ? "Move" : "Copy"} ${base(i.from ?? "")} to ${base(i.to ?? "")}?`, code: `${i.from} → ${i.to}`, body: ["It changes your working tree. You can undo it afterwards."] };
      return { title: `Create the folder ${base(i.path ?? "")}?`, code: i.path, body: ["It's created in your working tree."] };
    }
    case "git_write": {
      const i = obj<{ op?: string; message?: string; paths?: string[]; name?: string; ref?: string; pop?: boolean; stageAll?: boolean }>(input);
      const n = i.paths?.length ?? 0;
      switch (i.op) {
        case "commit": {
          const files = ctx.changedCount != null ? `the ${plural(ctx.changedCount, "changed file")}` : "your changed files";
          return {
            title: ctx.branch ? `Commit these changes to ${ctx.branch}?` : "Commit these changes?",
            code: `git commit -m "${i.message ?? ""}"`,
            body: ctx.branch
              ? [`This records ${files} on your local `, { b: ctx.branch }, " branch. Nothing leaves this Mac until you push."]
              : [`This records ${files} on your local branch. Nothing leaves this Mac until you push.`],
          };
        }
        case "stage":
          return { title: `Stage ${plural(n, "file")}?`, code: (i.paths ?? []).join(" "), body: ["Staging marks them for the next commit. Nothing is committed."] };
        case "unstage":
          return { title: `Unstage ${plural(n, "file")}?`, code: (i.paths ?? []).join(" "), body: ["They stay changed; they just leave the next commit."] };
        case "restore":
          return { title: `Discard your changes to ${plural(n, "file")}?`, code: (i.paths ?? []).join(" "), body: ["The files go back to how they were at the last commit. This can't be undone from here."] };
        case "branch":
          return { title: `Create the branch ${i.name}?`, code: `git branch ${i.name}`, body: ["It's created on this Mac. Nothing leaves it."] };
        case "checkout":
          return { title: `Switch to ${i.ref}?`, code: `git checkout ${i.ref}`, body: ["Your working tree changes to match that branch."] };
        case "stash":
          return { title: i.pop ? "Bring back your stashed changes?" : "Stash your changes?", code: i.pop ? "git stash pop" : "git stash", body: [i.pop ? "They return to your working tree." : "They're set aside until you bring them back."] };
        default:
          return { title: "Change git state?", body: ["The agent wants to run a git command that changes this project."] };
      }
    }
    case "browser": {
      const i = obj<{ op?: string; url?: string; ref?: string; text?: string; key?: string }>(input);
      if (i.op === "open") {
        return { title: `Open ${hostOf(i.url ?? "") || "a page"} in the Web pane?`, code: i.url, body: ["The page stays open after this turn ends. Rama can read it, but can't sign in for you."] };
      }
      const what = i.op === "click" ? "Click on" : i.op === "type" ? "Type into" : i.op === "press" ? "Press a key on" : i.op === "scroll" ? "Scroll" : "Use";
      return { title: `${what} the page in the Web pane?`, code: i.op === "type" && i.text ? `“${i.text}”` : i.ref ?? i.key, body: ["Rama acts on the page you can see in the Web pane."] };
    }
    case "process": {
      const i = obj<{ id?: string }>(input);
      const title = (i.id && ctx.terminalTitle?.(i.id)) || "this terminal";
      return { title: `Stop ${title}?`, body: ["It ends the process running in the Terminal pane."] };
    }
    default:
      return { title: `Allow ${tool.replace(/_/g, " ")}?`, body: ["The agent wants to use this tool."] };
  }
}

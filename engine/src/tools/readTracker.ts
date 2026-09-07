import { statSync } from "node:fs";
import { deleteFileRead, getFileRead, upsertFileRead } from "../db/fileReads";
import { resolveInProject } from "./paths";
import type { FileStamp } from "./types";

// docs/TOOL_LAYER_PLAN.md §5.1 — backs T4 (read-before-write) and M6 (workspace state tracking).
export interface ReadTracker {
  record(stamps: FileStamp[]): void;
  /** The mutating tools' precondition — re-stats the file at call time. */
  status(path: string): "ok" | "unread" | "stale";
  /** Called by mutate() right after a successful mutation: re-syncs the tracker to the file's
   *  new on-disk state rather than dropping it, so a tool's own write never makes its next call
   *  on the same file look "unread". */
  invalidate(paths: string[]): void;
}

// Shared by edit/write: the message the model sees when its read-before-write precondition
// fails. The wording matters more than the check — it needs to make the model re-read rather
// than retry blindly.
export function refusalForReadStatus(status: "unread" | "stale", path: string): string {
  if (status === "unread") {
    return `Refused: ${path} has not been read in this chat yet. Read it first — oldString must match its current, real contents.`;
  }
  return (
    `Refused: ${path} changed on disk since you last read it. Someone or something edited it ` +
    `outside this tool call — re-read it before editing, your oldString may no longer be accurate.`
  );
}

export function createReadTracker(chatId: string, projectPath: string): ReadTracker {
  return {
    record(stamps) {
      const now = Date.now();
      for (const stamp of stamps) {
        upsertFileRead(chatId, stamp.path, stamp.mtimeMs, stamp.size, now);
      }
    },

    status(path) {
      const row = getFileRead(chatId, path);
      if (!row) return "unread";
      let stat;
      try {
        stat = statSync(resolveInProject(projectPath, path));
      } catch {
        return "stale"; // gone since it was read — something changed, surface it as stale
      }
      if (stat.mtimeMs !== row.mtime_ms || stat.size !== row.size) return "stale";
      return "ok";
    },

    invalidate(paths) {
      const now = Date.now();
      for (const path of paths) {
        try {
          const stat = statSync(resolveInProject(projectPath, path));
          upsertFileRead(chatId, path, stat.mtimeMs, stat.size, now);
        } catch {
          deleteFileRead(chatId, path); // removed by this same mutation (e.g. file_op remove/move)
        }
      }
    },
  };
}

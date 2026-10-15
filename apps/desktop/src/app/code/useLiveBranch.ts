import { useEffect, useState } from "react";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import { fetchChatChanges } from "../../engine/client";
import { onProjectEvent } from "../../engine/ws";

/** The branch the crumbs show: the chat's own — its worktree's once isolation is on — falling back
 *  to the project's default while it loads or when the folder isn't a repo. Re-read when the
 *  working tree changes, when the window regains focus, and when the composer's worktree toggle
 *  fires `rama:branch-changed`. */
export function useLiveBranch(chat: ChatDTO | null, project: ProjectDTO | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  const chatId = chat?.id ?? null;
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!chatId) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () =>
      fetchChatChanges(chatId)
        .then((c) => !cancelled && setBranch(c.isRepo ? (c.detached ? "(detached)" : c.branch) : null))
        .catch(() => !cancelled && setBranch(null));
    void read();

    const off = onProjectEvent((pid, event) => {
      if (pid !== projectId || event.type !== "changes.invalidated") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 250);
    });
    window.addEventListener("focus", read);
    window.addEventListener("rama:branch-changed", read);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
      window.removeEventListener("focus", read);
      window.removeEventListener("rama:branch-changed", read);
    };
  }, [chatId, projectId]);

  return branch ?? project?.defaultBranch ?? null;
}

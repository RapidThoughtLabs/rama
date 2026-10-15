import { useEffect, useRef, useState } from "react";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import { fetchChanges, fetchChatChanges, fetchChatSettings, saveChatExtraRoots, setChatWorktree } from "../../../engine/client";

/* The composer's context chips — docs/COMPOSER_CONTEXT_PLAN.md CC0/CC1/CC2, moved out of
   CodeChat.tsx by docs/CODE_REDESIGN_PLAN.md CR5 with its behaviour unchanged. `branch` is real
   (chat-scoped: the worktree's own branch once one is active, the project's otherwise).
   `worktreeOn` and `extraFolders` are real too, backed by the chat's `settings_json` — but while
   viewing an unsent draft there is no chat id to persist against, so both stay local until
   `carryOver` applies them to the chat that promoteDraft creates. */

export interface ComposerContext {
  branch: string | null;
  worktreeOn: boolean;
  extraFolders: string[];
  toggleWorktree: (next: boolean) => void;
  addFolder: (path: string) => void;
  removeFolder: (path: string) => void;
  /** Called by submit() the moment promoteDraft resolves: persists what was chosen on the draft. */
  carryOver: (chatId: string) => void;
}

const branchLabel = (changes: { detached: boolean; branch: string | null }) => (changes.detached ? "(detached)" : changes.branch);

export function useComposerContext(project: ProjectDTO | undefined, chat: ChatDTO | undefined): ComposerContext {
  const [branch, setBranch] = useState<string | null>(null);
  const [worktreeOn, setWorktreeOn] = useState(false);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);

  // A draft's pending folders and worktree choice are carried onto the new chat by `carryOver` the
  // instant promoteDraft resolves — which is also the instant `chat?.id` below flips from undefined
  // to that chat's id and fires the settings fetch. Without this, the fetch's GET routinely wins
  // the race against carryOver's PUT/POST (a brand-new chat has empty defaults until that persist
  // call lands) and silently reverts the chips to empty/off, with nothing to correct it afterward
  // since this effect only re-fires on a chat-id change. Set right before persisting; consumed
  // (and cleared) below at most once.
  const skipNextSettingsFetchRef = useRef<string | null>(null);

  useEffect(() => {
    if (!project) {
      setBranch(null);
      setWorktreeOn(false);
      setExtraFolders([]);
      return;
    }

    let cancelled = false;

    if (chat) {
      const chatId = chat.id;
      fetchChatChanges(chatId)
        .then((changes) => {
          if (!cancelled) setBranch(branchLabel(changes));
        })
        .catch(() => {
          if (!cancelled) setBranch(project.defaultBranch ?? null);
        });
      if (skipNextSettingsFetchRef.current === chatId) {
        skipNextSettingsFetchRef.current = null;
      } else {
        fetchChatSettings(chatId)
          .then((settings) => {
            if (cancelled) return;
            setExtraFolders(settings.extraRoots);
            setWorktreeOn(settings.worktreeEnabled);
          })
          .catch(() => {
            if (!cancelled) {
              setExtraFolders([]);
              setWorktreeOn(false);
            }
          });
      }
    } else {
      // Viewing the draft — no chat id to load or persist against yet.
      setWorktreeOn(false);
      setExtraFolders([]);
      fetchChanges(project.id)
        .then((changes) => {
          if (!cancelled) setBranch(branchLabel(changes));
        })
        .catch(() => {
          if (!cancelled) setBranch(project.defaultBranch ?? null);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [project, chat?.id]);

  function addFolder(path: string) {
    const trimmed = path.trim();
    if (!trimmed || extraFolders.includes(trimmed)) return;
    const next = [...extraFolders, trimmed];
    setExtraFolders(next);
    if (chat) {
      saveChatExtraRoots(chat.id, next).catch((err) => {
        console.error("[rama] failed to save extra context folder", err);
        setExtraFolders((prev) => prev.filter((f) => f !== trimmed));
      });
    }
  }

  function removeFolder(folder: string) {
    const next = extraFolders.filter((f) => f !== folder);
    setExtraFolders(next);
    if (chat) {
      saveChatExtraRoots(chat.id, next).catch((err) => {
        console.error("[rama] failed to remove extra context folder", err);
        setExtraFolders((prev) => (prev.includes(folder) ? prev : [...prev, folder]));
      });
    }
  }

  // CC2 — the worktree toggle's real backend. Toggling mid-chat only affects tool calls from the
  // next turn on (run.ts computes effectiveProjectPath fresh per run); it does not carry any
  // uncommitted changes made before the toggle into the worktree, since `git worktree add` only
  // ever checks out committed state — see docs/COMPOSER_CONTEXT_PLAN.md CC2's open questions.
  function toggleWorktree(next: boolean) {
    setWorktreeOn(next);
    if (!chat) return; // no chat yet — remembered locally, carryOver applies it
    const chatId = chat.id;
    setChatWorktree(chatId, next)
      .then((settings) => {
        setWorktreeOn(settings.worktreeEnabled);
        return refreshBranch(chatId);
      })
      .catch((err) => {
        console.error("[rama] failed to toggle worktree", err);
        setWorktreeOn(!next);
      });
  }

  function refreshBranch(chatId: string) {
    return fetchChatChanges(chatId).then((changes) => {
      setBranch(branchLabel(changes));
      window.dispatchEvent(new Event("rama:branch-changed")); // the top bar's crumbs follow it
    });
  }

  function carryOver(chatId: string) {
    // Local state already shows the draft's choices correctly (that's where they came from) — tell
    // the effect above not to clobber it with a fetch that can race ahead of the persist calls.
    skipNextSettingsFetchRef.current = chatId;
    if (extraFolders.length) {
      saveChatExtraRoots(chatId, extraFolders).catch((err) => {
        console.error("[rama] failed to carry extra context folders into new chat", err);
      });
    }
    if (worktreeOn) {
      setChatWorktree(chatId, true)
        .then((settings) => {
          setWorktreeOn(settings.worktreeEnabled);
          return refreshBranch(chatId);
        })
        .catch((err) => {
          console.error("[rama] failed to enable worktree for new chat", err);
        });
    }
  }

  return { branch, worktreeOn, extraFolders, toggleWorktree, addFolder, removeFolder, carryOver };
}

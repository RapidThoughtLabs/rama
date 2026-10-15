import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Icon, Modal, useToast } from "@rama/ui";
import { patchChat } from "../../engine/client";
import { ChatTitle } from "../shell/ChatTitle";
import { useLiveBranch } from "./useLiveBranch";
import { useWorkspace } from "./workspace/WorkspaceContext";
import "./code.css";
import { useProjectsData } from "../data/ProjectsProvider";
import { useProvidersData } from "../data/ProvidersProvider";
import { useSettingsLink } from "../data/SettingsLinkContext";
import { useWindowTabsData } from "../data/WindowTabsProvider";

/* The Code tab's top-bar content (mock:L381-395, 767-776): the chat title menu, the project and
   branch crumbs (chat view only), then Commands ⌘K, the workspace toggle and pop-out. The
   broken-provider alert still lives here until the model menu takes it over (CR5/HD5). */
export function CodeTopbar() {
  const { projects, activeProjectId, viewingDraft, removeChat, applyChatPatch } = useProjectsData();
  const ws = useWorkspace();
  const { tabs, activeTabId, popOutTab } = useWindowTabsData();
  const { providers, health } = useProvidersData();
  const { open: openSettings } = useSettingsLink();
  const { push: pushToast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const badProviders = providers.filter((p) => health[p.id]?.status === "bad");
  const inChat = !!activeTab && !viewingDraft;
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const branch = useLiveBranch(inChat ? activeTab : null, project);

  async function rename(title: string) {
    if (!activeTab) return;
    try {
      applyChatPatch(await patchChat(activeTab.id, { title }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  async function remove() {
    if (!activeTab) return;
    setConfirmDelete(false);
    try {
      await removeChat(activeTab.id);
      invoke("remove_chat_from_windows", { chatId: activeTab.id }).catch((err) =>
        console.error("[rama] failed to clear deleted chat from window tabs", err),
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <>
      {activeTab && !viewingDraft && (
        <ChatTitle
          title={activeTab.title}
          onRename={rename}
          onDelete={() => setConfirmDelete(true)}
          items={tabs.length > 1 ? [{ label: "Pop out", icon: "pop", onSelect: () => void popOutTab(activeTab.id) }] : []}
        />
      )}
      {inChat && project && (
        <div className="r-crumbs">
          <span className="r-chip">
            <Icon name="folder" />
            {project.name}
          </span>
          {branch && (
            <span className="r-chip">
              <Icon name="branch" />
              {branch}
            </span>
          )}
        </div>
      )}
      <div className="r-topbar-spacer" />
      <div className="r-topbar-actions">
        {badProviders.length > 0 && (
          <button
            className="r-icon-btn"
            onClick={() => openSettings({ pane: "providers", providerId: badProviders[0].id })}
            title={badProviders.length === 1 ? `${badProviders[0].label} unavailable` : `${badProviders.length} providers unavailable`}
            aria-label="Provider unavailable"
          >
            <span className="r-alert-dot" />
          </button>
        )}
        <button className="r-cmd-btn" title="Commands" onClick={() => window.dispatchEvent(new CustomEvent("rama:toggle-palette"))}>
          <span>Commands</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          className="r-icon-btn"
          aria-pressed={ws.open}
          title={ws.open ? "Hide workspace" : "Show workspace"}
          aria-label={ws.open ? "Hide workspace" : "Show workspace"}
          onClick={ws.toggleOpen}
        >
          <Icon name="panel-r" />
        </button>
        <button
          className="r-icon-btn"
          disabled={!activeTab || tabs.length < 2}
          onClick={() => activeTab && void popOutTab(activeTab.id)}
          title="Open in a new window (⌘⇧O)"
          aria-label="Open in a new window"
        >
          <Icon name="pop" />
        </button>
      </div>
      {confirmDelete && (
        <div className="r-legacy">
          <Modal open={confirmDelete} title="Delete chat" onClose={() => setConfirmDelete(false)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: "var(--fs-md)", color: "rgba(var(--ink), 0.75)" }}>
                Delete chat "{activeTab?.title}"? This can't be undone.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  cancel
                </Button>
                <Button variant="ghost" size="sm" className="rama-btn-danger" onClick={remove}>
                  delete
                </Button>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </>
  );
}

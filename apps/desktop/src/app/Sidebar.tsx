import { useEffect, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Button, Input, Modal } from "@rama/ui";
import { getProviderKey, pushProviderSecret, setProviderKey } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";

function relativeTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function Sidebar() {
  const { projects, chatsByProject, activeChatId, activeProjectId, selectChat, addProject, loading } =
    useProjectsData();
  const { tabs, openNewTab, adoptChat } = useWindowTabsData();
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    getProviderKey("together")
      .then((key) => setKeyConfigured(!!key))
      .catch((err) => console.error("[rama] failed to read provider key", err));
  }, []);

  // A chat is a tab in at most one window at a time (docs/IMPLEMENTATION_PLAN.md Phase 5). If
  // it's already a tab here, just select it (and apply its theme, as selectChat always does).
  // Otherwise adopt it into this window — unless another window already owns it, in which case
  // adoption is a no-op and we focus that window instead of duplicating the tab.
  async function handleChatClick(chatId: string) {
    if (tabs.some((t) => t.id === chatId)) {
      selectChat(chatId);
      return;
    }
    const otherOwner = await adoptChat(chatId);
    if (otherOwner) {
      const win = await WebviewWindow.getByLabel(otherOwner);
      await win?.setFocus();
      return;
    }
    selectChat(chatId);
  }

  async function handleCreateProject() {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (!trimmedName || !trimmedPath) return;
    setSubmitting(true);
    try {
      await addProject({ name: trimmedName, path: trimmedPath });
      setName("");
      setPath("");
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveKey() {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSavingKey(true);
    try {
      await setProviderKey("together", trimmed);
      await pushProviderSecret("together", trimmed);
      setKeyConfigured(true);
      setApiKey("");
      setSettingsOpen(false);
    } catch (err) {
      console.error("[rama] failed to save provider key", err);
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <div className="rama-sidebar">
      <div className="rama-sidebar-header">
        <div className="rama-wordmark">
          ra<span className="rama-wordmark-m">m</span>a
        </div>
        <button
          className="rama-new-chat-btn"
          title="New chat · ⌘N"
          disabled={!activeProjectId}
          onClick={() => activeProjectId && openNewTab(activeProjectId)}
        >
          +
        </button>
      </div>

      <div className="rama-sidebar-search">
        <Input placeholder="⌕ search chats, files…" />
      </div>

      <div className="rama-sidebar-scroll">
        <div className="rama-sidebar-section-label">
          <span className="t-label">projects</span>
          <span
            style={{ fontSize: 10, color: "rgba(var(--ink),0.34)", cursor: "pointer" }}
            onClick={() => setModalOpen(true)}
          >
            + add
          </span>
        </div>

        {loading && projects.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "rgba(var(--ink),0.4)" }}>loading projects…</div>
        )}
        {!loading && projects.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "rgba(var(--ink),0.4)" }}>
            no projects yet — add one to start a chat.
          </div>
        )}

        {projects.map((project) => (
          <div key={project.id} style={{ marginBottom: 8 }}>
            <div className="rama-project">
              <span style={{ color: "rgba(var(--ink),0.35)", fontSize: 9 }}>▾</span>
              <span className="rama-project-name">{project.name}</span>
              <span style={{ flex: 1 }} />
              {project.defaultBranch && <span className="rama-project-branch">⑂ {project.defaultBranch}</span>}
            </div>
            <div className="rama-project-path">{project.path}</div>
            {(chatsByProject[project.id] ?? []).map((chat) => (
              <div
                key={chat.id}
                role="option"
                aria-selected={chat.id === activeChatId}
                className="rama-chat-row"
                onClick={() => handleChatClick(chat.id)}
              >
                <span className="rama-chat-row-dot" />
                <span className="rama-chat-row-name">{chat.title}</span>
                <span className="rama-chat-row-time">{relativeTime(chat.updatedAt)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="rama-sidebar-footer">
        <div className="rama-sidebar-footer-row">
          <span style={{ width: 16, textAlign: "center", color: "var(--accent)" }}>✦</span>
          <span style={{ flex: 1 }}>skills</span>
          <span style={{ fontSize: 10, opacity: 0.55 }}>12 installed</span>
        </div>
        <div className="rama-sidebar-footer-row">
          <span style={{ width: 16, textAlign: "center", color: "var(--accent)" }}>▤</span>
          <span style={{ flex: 1 }}>docs</span>
          <span style={{ fontSize: 10, opacity: 0.55 }}>4</span>
        </div>
        <div className="rama-sidebar-footer-row" style={{ cursor: "pointer" }} onClick={() => setSettingsOpen(true)}>
          <span style={{ width: 16, textAlign: "center", opacity: 0.7 }}>⚙</span>
          <span style={{ flex: 1 }}>settings</span>
          <span style={{ fontSize: 10, opacity: 0.55 }}>⌘,</span>
        </div>
      </div>

      <Modal open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, color: "rgba(var(--ink),0.5)" }}>
            Together AI API key —{" "}
            <span style={{ color: keyConfigured ? "var(--accent-bright, var(--accent))" : "rgba(var(--ink),0.4)" }}>
              {keyConfigured ? "configured ✓" : "not set"}
            </span>
          </div>
          <Input
            type="password"
            placeholder="paste your Together AI API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>
              cancel
            </Button>
            <Button size="sm" onClick={handleSaveKey} disabled={savingKey || !apiKey.trim()}>
              {savingKey ? "saving…" : "save"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={modalOpen} title="Add project" onClose={() => setModalOpen(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Input placeholder="path (e.g. ~/dev/my-project)" value={path} onChange={(e) => setPath(e.target.value)} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>
              cancel
            </Button>
            <Button size="sm" onClick={handleCreateProject} disabled={submitting || !name.trim() || !path.trim()}>
              {submitting ? "adding…" : "add project"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

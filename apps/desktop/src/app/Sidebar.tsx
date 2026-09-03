import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import {
  Button,
  Fluke,
  IconChevronDown,
  IconCode,
  IconDocs,
  IconHome,
  IconPanel,
  IconPlus,
  IconSearch,
  IconSun,
  IconToolbox,
  Input,
  Modal,
  useTheme,
  useToast,
} from "@rama/ui";
import { fetchDocs, fetchGeneralSettings, fetchMcpServers, fetchSkills } from "../engine/client";
import type { MainView } from "./AppShell";
import { useProjectsData } from "./data/ProjectsProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";

export function Sidebar({
  collapsed,
  onToggleCollapse,
  onOpenSettings,
  view,
  onNavigate,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  view: MainView;
  onNavigate: (view: MainView) => void;
}) {
  const {
    projects,
    chatsByProject,
    activeChatId,
    activeProjectId,
    selectChat,
    addProject,
    updateProject,
    removeProject,
    removeChat,
    loading,
  } = useProjectsData();
  const { tabs, windowLabel, openNewTab, adoptChat } = useWindowTabsData();
  const { cycleTheme } = useTheme();
  const { push: pushToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const [docCount, setDocCount] = useState<number | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // docs/REDESIGN_PLAN.md Phase R2 — which projects' chat lists are folded away. Tracked as the
  // collapsed set (not the expanded set) so newly-added projects default to expanded with no
  // sync effect needed to keep the set in step with the project list.
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(new Set());

  // docs/REDESIGN_PLAN.md Phase R2b — project `⋯` menu: which project's menu is open (at most
  // one at a time), and the in-progress inline rename/change-branch edit, if any.
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<{
    id: string;
    field: "name" | "defaultBranch";
    value: string;
  } | null>(null);

  // Same idea as the project `⋯` menu above, but for an individual chat row — at most one open
  // at a time, and sharing the same outside-click-closes effect below.
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);

  // Destructive confirmations go through this modal rather than window.confirm — Tauri's
  // WKWebView doesn't present a native panel for it (no WKUIDelegate wired up for JS dialogs),
  // so window.confirm() silently returns false and the delete/remove action looked like a no-op.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "chat"; chat: ChatDTO } | { kind: "project"; project: ProjectDTO } | null
  >(null);

  useEffect(() => {
    if (!openMenuProjectId && !openChatMenuId) return;
    function onDocClick(e: MouseEvent) {
      if (
        e.target instanceof Element &&
        e.target.closest(".rama-project-menu, .rama-project-menu-btn, .rama-chat-row-menu, .rama-chat-row-menu-btn")
      ) {
        return;
      }
      setOpenMenuProjectId(null);
      setOpenChatMenuId(null);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [openMenuProjectId, openChatMenuId]);

  // Which window (if any) owns each chat as a tab, across ALL windows — not just this one.
  // WindowTabsProvider deliberately only mirrors this window's own tabs (see its header
  // comment), so this reads the whole registry directly. Display-only: handleChatClick below
  // still resolves ownership itself at click time via adoptChat, it doesn't need this map.
  const [chatOwners, setChatOwners] = useState<Record<string, string>>({});

  function reloadSkillCount() {
    fetchSkills()
      .then((skills) => setSkillCount(skills.length))
      .catch(() => {});
  }

  function reloadMcpCount() {
    fetchMcpServers()
      .then((servers) => setMcpCount(servers.length))
      .catch(() => {});
  }

  function reloadDocCount() {
    if (!activeProjectId) {
      setDocCount(null);
      return;
    }
    fetchDocs(activeProjectId)
      .then((docs) => setDocCount(docs.length))
      .catch(() => {});
  }

  useEffect(() => {
    reloadSkillCount();
    reloadMcpCount();
  }, []);

  useEffect(reloadDocCount, [activeProjectId]);

  // docs/REDESIGN_PLAN.md Phase R6 — Toolbox/Docs are now pages (ToolboxPage.tsx/DocsPage.tsx),
  // not modals with an onChanged callback, so re-sync these nav-row counts whenever the user
  // navigates away from one — installs/removals that happened while there are picked up here.
  useEffect(() => {
    if (view !== "toolbox") {
      reloadSkillCount();
      reloadMcpCount();
    }
    if (view !== "docs") reloadDocCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    function refreshOwners() {
      invoke<Record<string, string[]>>("list_all_window_tabs")
        .then((byWindow) => {
          const owners: Record<string, string> = {};
          for (const [label, chatIds] of Object.entries(byWindow)) {
            for (const chatId of chatIds) owners[chatId] = label;
          }
          setChatOwners(owners);
        })
        .catch((err) => console.error("[rama] failed to read window registry", err));
    }
    refreshOwners();
    const unlisten = listen("registry-changed", refreshOwners);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function startRename(project: ProjectDTO) {
    setEditingProject({ id: project.id, field: "name", value: project.name });
    setOpenMenuProjectId(null);
  }

  function startChangeBranch(project: ProjectDTO) {
    setEditingProject({ id: project.id, field: "defaultBranch", value: project.defaultBranch ?? "" });
    setOpenMenuProjectId(null);
  }

  async function commitEdit() {
    if (!editingProject) return;
    const { id, field, value } = editingProject;
    const trimmed = value.trim();
    setEditingProject(null);
    if (field === "name" && !trimmed) return; // empty name — revert, don't save
    try {
      await updateProject(id, { [field]: trimmed });
    } catch (err) {
      console.error("[rama] failed to update project", err);
    }
  }

  function handleRemoveProject(project: ProjectDTO) {
    setOpenMenuProjectId(null);
    setPendingDelete({ kind: "project", project });
  }

  function handleDeleteChat(chat: ChatDTO) {
    setOpenChatMenuId(null);
    setPendingDelete({ kind: "chat", chat });
  }

  async function confirmPendingDelete() {
    if (!pendingDelete) return;
    const pending = pendingDelete;
    setPendingDelete(null);
    try {
      if (pending.kind === "chat") {
        await removeChat(pending.chat.id);
        // Best-effort: drops the chat's tab from whichever window (if any) still owns it — a
        // failure here would just leave a dangling tab id, nothing worth surfacing to the user.
        invoke("remove_chat_from_windows", { chatId: pending.chat.id }).catch((err) =>
          console.error("[rama] failed to clear deleted chat from window tabs", err),
        );
      } else {
        await removeProject(pending.project.id);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "bad");
    }
  }

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

  function openAddProjectModal() {
    setModalOpen(true);
    // docs/REDESIGN_PLAN.md Phase R4 — General pane's "default project directory". Only
    // prefills an empty field, so it never clobbers a path from a previous (cancelled) open in
    // this same window session.
    if (!path) {
      fetchGeneralSettings()
        .then((s) => {
          if (s.defaultProjectDir) setPath((prev) => prev || s.defaultProjectDir);
        })
        .catch(() => {});
    }
  }

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  // Every project — active one first — gets the same labeled, collapsible group header, so the
  // chat list always reads as grouped-by-project (previously the active project rendered with no
  // header at all, which left a single-project setup looking like a flat, ungrouped chat list).
  const orderedProjects = activeProject ? [activeProject, ...projects.filter((p) => p.id !== activeProjectId)] : projects;

  function matchesSearch(chat: ChatDTO): boolean {
    const term = searchTerm.trim().toLowerCase();
    return !term || chat.title.toLowerCase().includes(term);
  }

  function renderChatMenu(chat: ChatDTO) {
    return (
      <div className="rama-chat-row-menu" onClick={(e) => e.stopPropagation()}>
        <button className="rama-chat-row-menu-item rama-chat-row-menu-item-danger" onClick={() => handleDeleteChat(chat)}>
          delete
        </button>
      </div>
    );
  }

  function renderChatRow(chat: ChatDTO) {
    const owner = chatOwners[chat.id];
    const ownedElsewhere = !!owner && owner !== windowLabel;
    return (
      <div
        key={chat.id}
        role="option"
        aria-selected={chat.id === activeChatId}
        className="rama-chat-row"
        onClick={() => handleChatClick(chat.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpenChatMenuId(chat.id);
        }}
      >
        <span className="rama-chat-row-dot" />
        <span className="rama-chat-row-name">{chat.title}</span>
        {ownedElsewhere && (
          <span className="rama-chat-row-owner" title="Open in another window">
            ⧉
          </span>
        )}
        <button
          className={`rama-chat-row-menu-btn ${openChatMenuId === chat.id ? "rama-chat-row-menu-btn-open" : ""}`}
          title="Chat actions"
          onClick={(e) => {
            e.stopPropagation();
            setOpenChatMenuId((prev) => (prev === chat.id ? null : chat.id));
          }}
        >
          ⋯
        </button>
        {openChatMenuId === chat.id && renderChatMenu(chat)}
      </div>
    );
  }

  function renderProjectMenu(project: ProjectDTO) {
    return (
      <div className="rama-project-menu" onClick={(e) => e.stopPropagation()}>
        <button className="rama-project-menu-item" onClick={() => startRename(project)}>
          rename
        </button>
        <button className="rama-project-menu-item" onClick={() => startChangeBranch(project)}>
          change branch
        </button>
        <button
          className="rama-project-menu-item"
          onClick={() => {
            setOpenMenuProjectId(null);
            revealItemInDir(project.path).catch((err) => console.error("[rama] failed to reveal in Finder", err));
          }}
        >
          reveal in Finder
        </button>
        <button
          className="rama-project-menu-item"
          onClick={() => {
            setOpenMenuProjectId(null);
            openNewTab(project.id);
          }}
        >
          new chat here
        </button>
        <div className="rama-project-menu-divider" />
        <button className="rama-project-menu-item rama-project-menu-item-danger" onClick={() => handleRemoveProject(project)}>
          remove
        </button>
      </div>
    );
  }

  return (
    <div className={`rama-sidebar ${collapsed ? "rama-sidebar-collapsed" : ""}`}>
      <div className="rama-sidebar-inner">
        <div className="rama-sidebar-header">
          <div className="rama-sidebar-traffic-gap" />
          <div style={{ flex: 1 }} />
          <button className="rama-sidebar-header-btn" title="Collapse sidebar" onClick={onToggleCollapse}>
            <IconPanel />
          </button>
          <button
            className={`rama-sidebar-header-btn ${searchOpen ? "rama-sidebar-header-btn-active" : ""}`}
            title="Search chats"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <IconSearch />
          </button>
        </div>

        {searchOpen && (
          <div className="rama-sidebar-search">
            <Input
              placeholder="search chats…"
              value={searchTerm}
              autoFocus
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchTerm("");
                  setSearchOpen(false);
                }
              }}
              onBlur={() => {
                if (!searchTerm) setSearchOpen(false);
              }}
            />
          </div>
        )}

        <div className="rama-sidebar-viewtabs">
          <button
            className={`rama-sidebar-viewtab ${view === "home" ? "rama-sidebar-viewtab-active" : ""}`}
            onClick={() => onNavigate("home")}
          >
            <IconHome /> Home
          </button>
          <button
            className={`rama-sidebar-viewtab ${view === "code" ? "rama-sidebar-viewtab-active" : ""}`}
            onClick={() => onNavigate("code")}
          >
            <IconCode /> Code
          </button>
        </div>

        <div className="rama-sidebar-nav">
          <button
            className="rama-sidebar-nav-row"
            disabled={!activeProjectId}
            onClick={() => activeProjectId && openNewTab(activeProjectId)}
          >
            <span className="rama-sidebar-nav-row-glyph">
              <IconPlus />
            </span>
            <span style={{ flex: 1 }}>New chat</span>
            <span className="rama-sidebar-nav-row-meta">⌘N</span>
          </button>
          <button
            className={`rama-sidebar-nav-row ${view === "docs" ? "rama-sidebar-nav-row-active" : ""}`}
            onClick={() => onNavigate("docs")}
          >
            <span className="rama-sidebar-nav-row-glyph">
              <IconDocs />
            </span>
            <span style={{ flex: 1 }}>Docs</span>
            <span className="rama-sidebar-nav-row-meta">{docCount ?? "…"}</span>
          </button>
          <button
            className={`rama-sidebar-nav-row ${view === "toolbox" ? "rama-sidebar-nav-row-active" : ""}`}
            onClick={() => onNavigate("toolbox")}
          >
            <span className="rama-sidebar-nav-row-glyph">
              <IconToolbox />
            </span>
            <span style={{ flex: 1 }}>Toolbox</span>
            <span className="rama-sidebar-nav-row-meta">
              {skillCount ?? "…"} tools · {mcpCount ?? "…"} mcp
            </span>
          </button>
        </div>

        <div className="rama-sidebar-scroll">
          {loading && projects.length === 0 && <div className="rama-sidebar-empty-hint">loading projects…</div>}
          {!loading && projects.length === 0 && (
            <div className="rama-sidebar-empty-hint">no projects yet — add one to start a chat.</div>
          )}

          {orderedProjects.map((project) => {
            const isActive = project.id === activeProjectId;
            const projectCollapsed = collapsedProjectIds.has(project.id);
            const editing = editingProject?.id === project.id ? editingProject : null;
            return (
              <div key={project.id} style={{ marginBottom: 8 }}>
                <div
                  className={`rama-project ${isActive ? "rama-project-active" : ""}`}
                  title={project.path}
                  onClick={() => toggleProjectCollapsed(project.id)}
                >
                  <span className={`rama-project-toggle ${projectCollapsed ? "rama-project-toggle-collapsed" : ""}`}>
                    <IconChevronDown />
                  </span>
                  {editing?.field === "name" ? (
                    <input
                      className="rama-project-edit-input"
                      autoFocus
                      value={editing.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingProject({ ...editing, value: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setEditingProject(null);
                      }}
                    />
                  ) : (
                    <span className="rama-project-name">{project.name}</span>
                  )}
                  {editing?.field === "defaultBranch" ? (
                    <input
                      className="rama-project-edit-input"
                      style={{ flex: "0 1 100px", fontWeight: 400, fontSize: "var(--fs-sm)" }}
                      autoFocus
                      placeholder="branch"
                      value={editing.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingProject({ ...editing, value: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setEditingProject(null);
                      }}
                    />
                  ) : (
                    project.defaultBranch && <span className="rama-project-branch">⑂ {project.defaultBranch}</span>
                  )}
                  <button
                    className={`rama-project-menu-btn ${openMenuProjectId === project.id ? "rama-project-menu-btn-open" : ""}`}
                    title="Project actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuProjectId((prev) => (prev === project.id ? null : project.id));
                    }}
                  >
                    ⋯
                  </button>
                  {openMenuProjectId === project.id && renderProjectMenu(project)}
                </div>
                {!projectCollapsed && (chatsByProject[project.id] ?? []).filter(matchesSearch).map(renderChatRow)}
              </div>
            );
          })}

          {!loading && (
            <button className="rama-sidebar-add-project" onClick={openAddProjectModal}>
              <IconPlus />
              <span>add project</span>
            </button>
          )}
        </div>

        <div className="rama-sidebar-footer">
          <button className="rama-sidebar-account" onClick={onOpenSettings} title="Settings (⌘,)">
            <span className="rama-sidebar-avatar">
              <Fluke />
            </span>
            <span className="rama-sidebar-account-label">
              rama <span className="rama-sidebar-account-sub">· local</span>
            </span>
            <IconChevronDown />
          </button>
          <button className="rama-sidebar-header-btn" title="Cycle theme" onClick={cycleTheme}>
            <IconSun />
          </button>
        </div>
      </div>

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

      <Modal
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "chat" ? "Delete chat" : "Remove project"}
        onClose={() => setPendingDelete(null)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: "var(--fs-md)", color: "rgba(var(--ink), 0.75)" }}>
            {pendingDelete?.kind === "chat"
              ? `Delete chat "${pendingDelete.chat.title}"? This can't be undone.`
              : `Remove project "${pendingDelete?.kind === "project" ? pendingDelete.project.name : ""}"?`}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
              cancel
            </Button>
            <Button variant="ghost" size="sm" className="rama-btn-danger" onClick={confirmPendingDelete}>
              {pendingDelete?.kind === "chat" ? "delete" : "remove"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

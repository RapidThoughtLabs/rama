import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import { Button, Icon, Input, Modal, Popover, useToast, type IconName } from "@rama/ui";
import { fetchGeneralSettings } from "../../engine/client";
import "./code.css";
import { useNavigation } from "../data/NavigationProvider";
import { useProjectsData } from "../data/ProjectsProvider";
import { useWindowTabsData } from "../data/WindowTabsProvider";
import { useOpenChat } from "./useOpenChat";

/* Code's sidebar list (mock:L146-156, 495-499, 1522-1527) — HOME_REDESIGN_PLAN.md Phase HD1 split
   it out of the old Sidebar.tsx (§3 rule 2); docs/CODE_REDESIGN_PLAN.md CR2 restyles it. The
   chrome around it (traffic-light row, segment, nav rows, search field, footer) is
   shell/Sidebar.tsx. Per project a label (folder, name, hover `+` for a new draft), then its chats
   as rows. Project groups no longer collapse (§9.2); the project and chat actions moved from `⋯`
   buttons to right-click menus, and the project's inline rename and branch edit stay. */

type MenuSubject = { kind: "chat"; chat: ChatDTO } | { kind: "project"; project: ProjectDTO };
type MenuTarget = MenuSubject & { x: number; y: number };

const RUNNING = new Set(["thinking", "streaming", "tool"]);

function MenuItem({ icon, label, onSelect, danger }: { icon: IconName; label: string; onSelect: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" className={danger ? "r-mp-item danger" : "r-mp-item"} onClick={onSelect}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

export function CodeChatList({ query }: { query: string }) {
  const {
    projects,
    chatsByProject,
    activeChatId,
    viewingDraft,
    openDraft,
    addProject,
    updateProject,
    removeProject,
    removeChat,
    loading,
  } = useProjectsData();
  const { tabs, windowLabel, popOutTab } = useWindowTabsData();
  const nav = useNavigation();
  const { push: pushToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Right-click menu (one at a time, at the pointer) and the in-progress inline rename / branch
  // edit of a project label.
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editingProject, setEditingProject] = useState<{
    id: string;
    field: "name" | "defaultBranch";
    value: string;
  } | null>(null);

  // Destructive confirmations go through this modal rather than window.confirm — Tauri's
  // WKWebView doesn't present a native panel for it (no WKUIDelegate wired up for JS dialogs),
  // so window.confirm() silently returns false and the delete/remove action looked like a no-op.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "chat"; chat: ChatDTO } | { kind: "project"; project: ProjectDTO } | null
  >(null);

  // Which window (if any) owns each chat as a tab, across ALL windows — not just this one.
  // WindowTabsProvider deliberately only mirrors this window's own tabs (see its header
  // comment), so this reads the whole registry directly. Display-only: handleChatClick below
  // still resolves ownership itself at click time via adoptChat, it doesn't need this map.
  const [chatOwners, setChatOwners] = useState<Record<string, string>>({});

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

  function startRename(project: ProjectDTO) {
    setMenu(null);
    setEditingProject({ id: project.id, field: "name", value: project.name });
  }

  function startChangeBranch(project: ProjectDTO) {
    setMenu(null);
    setEditingProject({ id: project.id, field: "defaultBranch", value: project.defaultBranch ?? "" });
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
    setMenu(null);
    setPendingDelete({ kind: "project", project });
  }

  function handleDeleteChat(chat: ChatDTO) {
    setMenu(null);
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

  // See useOpenChat: select the chat if it is a tab here, adopt it if no window has it, else focus its window.
  const handleChatClick = useOpenChat();

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

  // docs/COMPOSER_CONTEXT_PLAN.md CC0 — the composer's folder pill (CodeComposer.tsx) opens this
  // same modal rather than forking its own add-project flow. Mirrored into a ref so the
  // mount-only listener always calls the latest closure (same pattern as CodeChat.tsx's
  // runCommandRef).
  const openAddProjectModalRef = useRef(openAddProjectModal);
  openAddProjectModalRef.current = openAddProjectModal;

  useEffect(() => {
    function onOpen() {
      openAddProjectModalRef.current();
    }
    window.addEventListener("rama:open-add-project", onOpen);
    return () => window.removeEventListener("rama:open-add-project", onOpen);
  }, []);

  // Projects keep their order, as the mockup draws them (the old sidebar floated the active one to
  // the top, which made the list jump on every chat switch). docs/CODE_REDESIGN_PLAN.md §9.
  const orderedProjects = projects;

  function matchesSearch(chat: ChatDTO): boolean {
    const term = query.trim().toLowerCase();
    return !term || chat.title.toLowerCase().includes(term);
  }

  function openMenu(e: React.MouseEvent, target: MenuSubject) {
    e.preventDefault();
    e.stopPropagation();
    // Keep the 200px menu on screen.
    const x = Math.min(e.clientX, window.innerWidth - 216);
    const y = Math.min(e.clientY, window.innerHeight - 220);
    setMenu({ ...target, x, y });
  }

  function renderChatRow(chat: ChatDTO) {
    const owner = chatOwners[chat.id];
    const ownedElsewhere = !!owner && owner !== windowLabel;
    const current = !viewingDraft && chat.id === activeChatId;
    return (
      <button
        key={chat.id}
        className="r-chat-row"
        aria-current={current}
        onClick={() => handleChatClick(chat.id)}
        onContextMenu={(e) => openMenu(e, { kind: "chat", chat })}
      >
        <span className="t">{chat.title}</span>
        {ownedElsewhere && <Icon name="pop" className="owner" aria-label="Open in another window" />}
        {chat.status === "waiting_permission" ? (
          <span className="flag" title="Waiting for your OK" />
        ) : RUNNING.has(chat.status) ? (
          <span className="running" title="Working" />
        ) : null}
      </button>
    );
  }

  function renderProjectLabel(project: ProjectDTO) {
    const editing = editingProject?.id === project.id ? editingProject : null;
    const input = (field: "name" | "defaultBranch", placeholder?: string) => (
      <input
        className="r-project-edit"
        autoFocus
        placeholder={placeholder}
        aria-label={field === "name" ? "Project name" : "Default branch"}
        value={editing!.value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setEditingProject({ ...editing!, value: e.target.value })}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit();
          if (e.key === "Escape") setEditingProject(null);
        }}
      />
    );
    return (
      <div className="r-project-label" title={project.path} onContextMenu={(e) => openMenu(e, { kind: "project", project })}>
        <Icon name="folder" />
        {editing?.field === "name" ? input("name") : <span>{project.name}</span>}
        {editing?.field === "defaultBranch" && input("defaultBranch", "branch")}
        <button
          className="r-icon-btn add"
          title={`New chat in ${project.name}`}
          aria-label={`New chat in ${project.name}`}
          onClick={() => {
            openDraft(project.id);
            nav.goSection("code");
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
    );
  }

  return (
    <>
      {loading && projects.length === 0 && <div className="r-sb-empty">Loading projects…</div>}
      {!loading && projects.length === 0 && <div className="r-sb-empty">No projects yet. Add one to start a chat.</div>}

      {orderedProjects.map((project) => (
        <div key={project.id}>
          {renderProjectLabel(project)}
          {(chatsByProject[project.id] ?? []).filter(matchesSearch).map(renderChatRow)}
        </div>
      ))}

      {/* Not in the mockup (§9): the only sidebar entry point for adding a project. Masked in parity. */}
      {!loading && (
        <button className="r-add-project" data-pixel-mask onClick={openAddProjectModal}>
          <Icon name="plus" />
          Add project
        </button>
      )}

      <Popover open={menu !== null} onClose={() => setMenu(null)} className="r-menu" role="menu" style={menu ? { left: menu.x, top: menu.y } : undefined}>
        {menu?.kind === "chat" && (
          <>
            {tabs.some((t) => t.id === menu.chat.id) && tabs.length > 1 && (
              <MenuItem
                icon="pop"
                label="Pop out"
                onSelect={() => {
                  setMenu(null);
                  void popOutTab(menu.chat.id);
                }}
              />
            )}
            <MenuItem icon="x" label="Delete chat" danger onSelect={() => handleDeleteChat(menu.chat)} />
          </>
        )}
        {menu?.kind === "project" && (
          <>
            <MenuItem
              icon="plus"
              label="New chat here"
              onSelect={() => {
                setMenu(null);
                openDraft(menu.project.id);
                nav.goSection("code");
              }}
            />
            <MenuItem icon="pencil" label="Rename" onSelect={() => startRename(menu.project)} />
            <MenuItem icon="branch" label="Change branch" onSelect={() => startChangeBranch(menu.project)} />
            <MenuItem
              icon="folder"
              label="Reveal in Finder"
              onSelect={() => {
                setMenu(null);
                revealItemInDir(menu.project.path).catch((err) => console.error("[rama] failed to reveal in Finder", err));
              }}
            />
            <MenuItem icon="x" label="Remove project" danger onSelect={() => handleRemoveProject(menu.project)} />
          </>
        )}
      </Popover>

      {/* Modals keep the legacy look until the settings/forms pass. */}
      <div className="r-legacy">
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
    </>
  );
}

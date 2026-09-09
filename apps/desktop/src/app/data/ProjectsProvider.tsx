import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTheme } from "@rama/ui";
import type { ThemeId } from "@rama/ui";
import type { BackendConfig, ChatDTO, ChatMode, ProjectDTO, UpdateProjectInput } from "@rama/protocol";
import {
  createChat as createChatApi,
  createProject as createProjectApi,
  deleteChat as deleteChatApi,
  deleteProject as deleteProjectApi,
  fetchChats,
  fetchGeneralSettings,
  fetchProjects,
  patchChat,
  updateProject as updateProjectApi,
} from "../../engine/client";
import { onEvent } from "../../engine/ws";
import { WINDOW_LABEL } from "../../engine/window";

// Real projects/chats + per-chat theme persistence (docs/IMPLEMENTATION_PLAN.md Phase 1),
// replacing the mockData.ts wiring from Phase 0.

// Label-suffixed (Phase 5, docs/IMPLEMENTATION_PLAN.md): each window is an independent instance
// of this provider, so a single shared key would make multiple windows fight over "the" last
// active chat.
const ACTIVE_CHAT_STORAGE_KEY = `rama.activeChatId.${WINDOW_LABEL}`;

export interface ProjectsDataValue {
  loading: boolean;
  error: string | null;
  projects: ProjectDTO[];
  chatsByProject: Record<string, ChatDTO[]>;
  allChats: ChatDTO[];
  activeChatId: string | null;
  activeProjectId: string | null;
  selectChat: (chatId: string) => void;
  addProject: (input: { name: string; path: string }) => Promise<ProjectDTO>;
  updateProject: (projectId: string, patch: UpdateProjectInput) => Promise<ProjectDTO>;
  removeProject: (projectId: string) => Promise<void>;
  addChat: (projectId: string, backend?: BackendConfig) => Promise<ChatDTO>;
  removeChat: (chatId: string) => Promise<void>;
  applyChatPatch: (chat: ChatDTO) => void;
}

const ProjectsContext = createContext<ProjectsDataValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { themeId, applyTheme } = useTheme();
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [chatsByProject, setChatsByProject] = useState<Record<string, ChatDTO[]>>({});
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // docs/REDESIGN_PLAN.md Phase R4 — General pane's "default chat mode", applied to chats created
  // via addChat below. Loaded once; the Settings modal writes straight through the engine, so a
  // change only takes effect for chats created after this provider next mounts (a fresh window).
  const [defaultMode, setDefaultMode] = useState<ChatMode>("agent");
  useEffect(() => {
    fetchGeneralSettings()
      .then((s) => setDefaultMode(s.defaultMode))
      .catch((err) => console.error("[rama] failed to load default chat mode", err));
  }, []);

  // Tracks the theme values we last pushed onto the chrome (from selecting a chat or from
  // the app just loading it), so the persistence effect below can tell "the active chat
  // changed and brought its own theme with it" apart from "the user changed the theme while
  // this chat is active" — only the latter should PATCH the chat.
  const lastAppliedTheme = useRef<{ themeId: string } | null>(null);

  // Mirrors `activeChatId` so the initial-load effect below (which only runs once and closes
  // over whatever `activeChatId` was at mount, i.e. always null) can check the *current* value
  // instead of a stale one — see its own comment for why that matters.
  const activeChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const allChats = useMemo(
    () => Object.values(chatsByProject).flat().sort((a, b) => b.updatedAt - a.updatedAt),
    [chatsByProject],
  );

  const activeProjectId = useMemo(() => {
    const chat = allChats.find((c) => c.id === activeChatId);
    if (chat) return chat.projectId;
    return projects[0]?.id ?? null;
  }, [activeChatId, allChats, projects]);

  const selectChat = useCallback(
    (chatId: string) => {
      setActiveChatId(chatId);
      window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, chatId);
      const chat = allChats.find((c) => c.id === chatId);
      if (chat) {
        lastAppliedTheme.current = { themeId: chat.themeId };
        applyTheme({ themeId: chat.themeId as ThemeId });
      }
    },
    [allChats, applyTheme],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projectList = await fetchProjects();
        if (cancelled) return;
        setProjects(projectList);

        const entries = await Promise.all(
          projectList.map(async (p) => [p.id, await fetchChats(p.id)] as const),
        );
        if (cancelled) return;
        const byProject = Object.fromEntries(entries) as Record<string, ChatDTO[]>;
        setChatsByProject(byProject);

        const storedId = window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
        const flat = Object.values(byProject).flat();
        const initialChat = flat.find((c) => c.id === storedId) ?? flat[0];
        // Guard against clobbering a selection WindowTabsProvider may have already made in the
        // interim (e.g. a spawned drag-target window correcting to the tab it actually owns) —
        // this fetch racing that correction shouldn't be able to stomp it back to "most recently
        // updated chat globally", which is only a reasonable guess when nothing else has spoken
        // up yet.
        if (initialChat && activeChatIdRef.current == null) {
          setActiveChatId(initialChat.id);
          lastAppliedTheme.current = { themeId: initialChat.themeId };
          applyTheme({ themeId: initialChat.themeId as ThemeId });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTheme]);

  // The one place a chat mutated elsewhere (model/agent pickers, theme sync) gets folded back
  // into chatsByProject — without this, patchChat's server-side write succeeds but every consumer
  // of allChats (the composer pill, the sidebar) keeps rendering the pre-patch chat forever, since
  // nothing else here re-fetches after a PATCH.
  const applyChatPatch = useCallback((updated: ChatDTO) => {
    setChatsByProject((prev) => {
      const list = prev[updated.projectId];
      if (!list) return prev;
      return { ...prev, [updated.projectId]: list.map((c) => (c.id === updated.id ? updated : c)) };
    });
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    const current = { themeId };
    const last = lastAppliedTheme.current;
    if (last && last.themeId === current.themeId) {
      return;
    }
    lastAppliedTheme.current = current;
    patchChat(activeChatId, current)
      .then(applyChatPatch)
      .catch((err) => {
        console.error("[rama] failed to persist chat theme", err);
      });
  }, [themeId, activeChatId, applyChatPatch]);

  // docs/PROVIDERS_PLAN.md Phase P2 — auto-titling's only way to reach the sidebar; a chat's
  // title lives in this provider's chatsByProject, not SessionProvider's per-run state, so the
  // rename has to be applied here rather than where the rest of the WS event stream is handled.
  useEffect(() => {
    return onEvent((_chatId, event) => {
      if (event.type !== "chat.renamed") return;
      setChatsByProject((prev) => {
        for (const [projectId, list] of Object.entries(prev)) {
          const idx = list.findIndex((c) => c.id === event.chatId);
          if (idx === -1) continue;
          const nextList = [...list];
          nextList[idx] = { ...nextList[idx], title: event.title };
          return { ...prev, [projectId]: nextList };
        }
        return prev;
      });
    });
  }, []);

  const addProject = useCallback(async (input: { name: string; path: string }) => {
    const project = await createProjectApi(input);
    setProjects((prev) => [...prev, project]);
    setChatsByProject((prev) => ({ ...prev, [project.id]: [] }));
    return project;
  }, []);

  const updateProject = useCallback(async (projectId: string, patch: UpdateProjectInput) => {
    const project = await updateProjectApi(projectId, patch);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? project : p)));
    return project;
  }, []);

  // Rejects with a message (see engine/src/db/projects.ts's deleteProject) rather than removing
  // local state, if the project still has chats — nothing to reconcile client-side on failure.
  const removeProject = useCallback(async (projectId: string) => {
    await deleteProjectApi(projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setChatsByProject((prev) => {
      const { [projectId]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const addChat = useCallback(
    async (projectId: string, backend?: BackendConfig) => {
      const chat = await createChatApi(projectId, { title: "new chat", themeId, mode: defaultMode, backend });
      setChatsByProject((prev) => ({ ...prev, [projectId]: [chat, ...(prev[projectId] ?? [])] }));
      selectChat(chat.id);
      return chat;
    },
    [themeId, defaultMode, selectChat],
  );

  // Deletes the chat everywhere (engine DB + local state) and, if it was the active one, hands
  // the selection to another chat in the same project, else any other chat, else nothing.
  const removeChat = useCallback(
    async (chatId: string) => {
      const chat = allChats.find((c) => c.id === chatId);
      await deleteChatApi(chatId);
      setChatsByProject((prev) => {
        const projectId = chat?.projectId;
        if (!projectId || !prev[projectId]) return prev;
        return { ...prev, [projectId]: prev[projectId].filter((c) => c.id !== chatId) };
      });
      if (activeChatId !== chatId) return;
      const remaining = allChats.filter((c) => c.id !== chatId);
      const next = remaining.find((c) => c.projectId === chat?.projectId) ?? remaining[0] ?? null;
      if (next) selectChat(next.id);
      else {
        setActiveChatId(null);
        window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
      }
    },
    [allChats, activeChatId, selectChat],
  );

  const value = useMemo<ProjectsDataValue>(
    () => ({
      loading,
      error,
      projects,
      chatsByProject,
      allChats,
      activeChatId,
      activeProjectId,
      selectChat,
      addProject,
      updateProject,
      removeProject,
      addChat,
      removeChat,
      applyChatPatch,
    }),
    [
      loading,
      error,
      projects,
      chatsByProject,
      allChats,
      activeChatId,
      activeProjectId,
      selectChat,
      addProject,
      updateProject,
      removeProject,
      addChat,
      removeChat,
      applyChatPatch,
    ],
  );

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjectsData(): ProjectsDataValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjectsData must be used within a ProjectsProvider");
  return ctx;
}

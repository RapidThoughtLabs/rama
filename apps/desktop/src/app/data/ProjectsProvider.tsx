import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTheme } from "@rama/ui";
import type { Accent, ThemeMode, Wallpaper } from "@rama/ui";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import {
  createChat as createChatApi,
  createProject as createProjectApi,
  fetchChats,
  fetchProjects,
  patchChat,
} from "../../engine/client";
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
  addChat: (projectId: string) => Promise<ChatDTO>;
}

const ProjectsContext = createContext<ProjectsDataValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { theme, accent, wallpaper, applyTheme } = useTheme();
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [chatsByProject, setChatsByProject] = useState<Record<string, ChatDTO[]>>({});
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tracks the theme values we last pushed onto the chrome (from selecting a chat or from
  // the app just loading it), so the persistence effect below can tell "the active chat
  // changed and brought its own theme with it" apart from "the user changed the theme while
  // this chat is active" — only the latter should PATCH the chat.
  const lastAppliedTheme = useRef<{ theme: string; accent: string; wallpaper: string } | null>(null);

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
        lastAppliedTheme.current = { theme: chat.theme, accent: chat.accent, wallpaper: chat.wallpaper };
        applyTheme({
          theme: chat.theme as ThemeMode,
          accent: chat.accent as Accent,
          wallpaper: chat.wallpaper as Wallpaper,
        });
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
          lastAppliedTheme.current = {
            theme: initialChat.theme,
            accent: initialChat.accent,
            wallpaper: initialChat.wallpaper,
          };
          applyTheme({
            theme: initialChat.theme as ThemeMode,
            accent: initialChat.accent as Accent,
            wallpaper: initialChat.wallpaper as Wallpaper,
          });
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

  useEffect(() => {
    if (!activeChatId) return;
    const current = { theme, accent, wallpaper };
    const last = lastAppliedTheme.current;
    if (last && last.theme === current.theme && last.accent === current.accent && last.wallpaper === current.wallpaper) {
      return;
    }
    lastAppliedTheme.current = current;
    patchChat(activeChatId, current)
      .then((updated) => {
        setChatsByProject((prev) => {
          const list = prev[updated.projectId];
          if (!list) return prev;
          return { ...prev, [updated.projectId]: list.map((c) => (c.id === updated.id ? updated : c)) };
        });
      })
      .catch((err) => {
        console.error("[rama] failed to persist chat theme", err);
      });
  }, [theme, accent, wallpaper, activeChatId]);

  const addProject = useCallback(async (input: { name: string; path: string }) => {
    const project = await createProjectApi(input);
    setProjects((prev) => [...prev, project]);
    setChatsByProject((prev) => ({ ...prev, [project.id]: [] }));
    return project;
  }, []);

  const addChat = useCallback(
    async (projectId: string) => {
      const chat = await createChatApi(projectId, { title: "new chat", theme, accent, wallpaper });
      setChatsByProject((prev) => ({ ...prev, [projectId]: [chat, ...(prev[projectId] ?? [])] }));
      selectChat(chat.id);
      return chat;
    },
    [theme, accent, wallpaper, selectChat],
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
      addChat,
    }),
    [loading, error, projects, chatsByProject, allChats, activeChatId, activeProjectId, selectChat, addProject, addChat],
  );

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjectsData(): ProjectsDataValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjectsData must be used within a ProjectsProvider");
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { WINDOW_LABEL } from "../../engine/window";

/* HOME_REDESIGN_PLAN.md Phase HD1 — what the main area shows, lifted out of AppShell's local
   state so the sidebar frame, the top bar, the command palette and (HD3) session routing can all
   read it without prop-drilling.

   `section` is the sidebar's Home/Code segment and decides which chat list the sidebar renders.
   `view` is what's in `.r-main`: the section's own view, or a page (Toolbox, Docs) reached from a
   nav row. Pages leave `section` alone, so the sidebar keeps showing whichever list you came from.
   `homeView`/`homeChatId` are Home's own landing-vs-chat state (HD5/HD6); Code's equivalent lives
   in ProjectsProvider (draft vs active chat) and isn't duplicated here.

   `section` and `sidebarOpen` persist per window, the same way the active-chat key does. */

export type Section = "home" | "code";
export type MainView = "home" | "code" | "toolbox" | "docs";
export type HomeView = "landing" | "chat";

export interface NavigationValue {
  section: Section;
  view: MainView;
  homeView: HomeView;
  homeChatId: string | null;
  /** Bumped by every goHomeLanding, so the landing re-keys and replays its arrival (HD5, mock:L1858)
   *  even when it was already showing. */
  landingKey: number;
  sidebarOpen: boolean;
  /** The segment: switch section and show that section's view (its last chat or its landing). */
  goSection: (section: Section) => void;
  /** A nav-row page. Doesn't change `section`. */
  goPage: (page: "toolbox" | "docs") => void;
  goHomeLanding: () => void;
  openHomeChat: (chatId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const STORAGE_KEY = `rama.nav.${WINDOW_LABEL}`;

interface Persisted {
  section: Section;
  sidebarOpen: boolean;
}

function loadPersisted(): Persisted {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { section: parsed.section === "home" ? "home" : "code", sidebarOpen: parsed.sidebarOpen !== false };
    }
  } catch {
    // fall through to defaults
  }
  return { section: "code", sidebarOpen: true };
}

const NavigationContext = createContext<NavigationValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadPersisted);
  // Secondary windows only ever show a code chat — they have no sidebar to navigate from.
  const isMain = WINDOW_LABEL === "main";
  const [section, setSection] = useState<Section>(isMain ? initial.section : "code");
  const [view, setView] = useState<MainView>(isMain ? initial.section : "code");
  const [homeView, setHomeView] = useState<HomeView>("landing");
  const [homeChatId, setHomeChatId] = useState<string | null>(null);
  const [landingKey, setLandingKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ section, sidebarOpen } satisfies Persisted));
    } catch {
      // best-effort
    }
  }, [section, sidebarOpen]);

  const goSection = useCallback((next: Section) => {
    setSection(next);
    setView(next);
  }, []);
  const goPage = useCallback((page: "toolbox" | "docs") => setView(page), []);
  const goHomeLanding = useCallback(() => {
    setSection("home");
    setView("home");
    setHomeView("landing");
    setHomeChatId(null);
    setLandingKey((k) => k + 1);
  }, []);
  const openHomeChat = useCallback((chatId: string) => {
    setSection("home");
    setView("home");
    setHomeView("chat");
    setHomeChatId(chatId);
  }, []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo<NavigationValue>(
    () => ({
      section,
      view,
      homeView,
      homeChatId,
      landingKey,
      sidebarOpen,
      goSection,
      goPage,
      goHomeLanding,
      openHomeChat,
      setSidebarOpen,
      toggleSidebar,
    }),
    [section, view, homeView, homeChatId, landingKey, sidebarOpen, goSection, goPage, goHomeLanding, openHomeChat, toggleSidebar],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation must be used within a NavigationProvider");
  return ctx;
}

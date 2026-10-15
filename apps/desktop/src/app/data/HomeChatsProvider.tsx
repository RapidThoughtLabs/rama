import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { HomeChatSummaryDTO } from "@rama/protocol";
import { ConfirmDialog } from "@rama/ui";
import { createHomeChat, deleteChat, fetchHomeChats, fetchModelRoles, patchChat, setHomeWebSearch, uploadHomeAttachment } from "../../engine/client";
import { onEvent } from "../../engine/ws";
import { useNavigation } from "./NavigationProvider";
import { useSessionData } from "./SessionProvider";

/* HOME_REDESIGN_PLAN.md Phase HD3 — Home's chat list and its one draft. Home chats never enter
   WindowTabsProvider (no tabs, no pop-out, main window only), so this is the whole client-side
   model for them. Which Home chat is on screen lives in NavigationProvider (`homeChatId`); this
   mirrors it as `activeHomeChatId` for convenience.

   The list re-fetches when a run finishes, so the snippet and the date grouping (updatedAt) stay
   live; a title change (chat.renamed) is folded in directly. */

export interface HomeDraft {
  text: string;
  providerId: string | null;
  model: string | null;
  webSearch: boolean;
  /** HD7 — files waiting in the landing composer; uploaded once the chat exists. */
  files: File[];
}

export interface HomeChatsValue {
  homeChats: HomeChatSummaryDTO[];
  loading: boolean;
  activeHomeChatId: string | null;
  draft: HomeDraft;
  updateDraft: (patch: Partial<HomeDraft>) => void;
  /** Creates a chat from the draft, uploads its files, opens it, and sends the draft as its first
   *  message. If a file can't be uploaded the new chat is removed again, the draft is kept, and
   *  the error is thrown for the landing to show. */
  createFromDraft: () => Promise<HomeChatSummaryDTO | null>;
  rename: (chatId: string, title: string) => Promise<void>;
  /** Switches an existing Home chat's model (the model menu, HD5). */
  setModel: (chatId: string, providerId: string, model: string) => Promise<void>;
  /** HD7 — an existing Home chat's globe toggle. */
  setWebSearch: (chatId: string, on: boolean) => Promise<void>;
  remove: (chatId: string) => Promise<void>;
  /** Asks first (the kit confirm dialog, HD4), then removes. Used by the sidebar row menu and the
   *  top bar's chat-title menu, so there's one dialog for both. */
  requestRemove: (chatId: string) => void;
  refresh: () => Promise<void>;
}

const EMPTY_DRAFT: HomeDraft = { text: "", providerId: null, model: null, webSearch: false, files: [] };

const HomeChatsContext = createContext<HomeChatsValue | null>(null);

export function HomeChatsProvider({ children }: { children: ReactNode }) {
  const nav = useNavigation();
  const { sendUserTurnTo } = useSessionData();
  const [homeChats, setHomeChats] = useState<HomeChatSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<HomeDraft>(EMPTY_DRAFT);
  const [pendingRemove, setPendingRemove] = useState<HomeChatSummaryDTO | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHomeChats(await fetchHomeChats());
    } catch (err) {
      console.error("[rama] failed to load Home chats", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The draft's model starts on the "chat" role, the same default the engine would pick.
  useEffect(() => {
    fetchModelRoles()
      .then((roles) => {
        const chat = roles.chat;
        if (!chat) return;
        setDraft((d) => (d.providerId ? d : { ...d, providerId: chat.providerId, model: chat.modelId }));
      })
      .catch((err) => console.error("[rama] failed to load default Home model", err));
  }, []);

  useEffect(() => {
    return onEvent((_chatId, event) => {
      if (event.type === "chat.renamed") {
        setHomeChats((prev) => prev.map((c) => (c.id === event.chatId ? { ...c, title: event.title } : c)));
      } else if (event.type === "run.finished") {
        void refresh();
      }
    });
  }, [refresh]);

  const updateDraft = useCallback((patch: Partial<HomeDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  const createFromDraft = useCallback(async () => {
    const text = draft.text.trim();
    if (!text && draft.files.length === 0) return null;
    const chat = await createHomeChat({
      providerId: draft.providerId ?? undefined,
      model: draft.model ?? undefined,
      webSearch: draft.webSearch,
    });
    let attachmentIds: string[] = [];
    try {
      attachmentIds = (await Promise.all(draft.files.map((f) => uploadHomeAttachment(chat.id, f)))).map((a) => a.id);
    } catch (err) {
      deleteChat(chat.id).catch(() => {});
      throw err;
    }
    setHomeChats((prev) => [chat, ...prev]);
    setDraft((d) => ({ ...d, text: "", files: [] }));
    nav.openHomeChat(chat.id);
    sendUserTurnTo(chat.id, text, attachmentIds);
    return chat;
  }, [draft, nav, sendUserTurnTo]);

  const rename = useCallback(async (chatId: string, title: string) => {
    const updated = await patchChat(chatId, { title });
    setHomeChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: updated.title } : c)));
  }, []);

  const setModel = useCallback(async (chatId: string, providerId: string, model: string) => {
    const updated = await patchChat(chatId, { providerId, model });
    setHomeChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, providerId: updated.providerId, model: updated.model } : c)));
  }, []);

  const setWebSearch = useCallback(async (chatId: string, on: boolean) => {
    setHomeChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, webSearch: on } : c)));
    await setHomeWebSearch(chatId, on);
  }, []);

  const remove = useCallback(
    async (chatId: string) => {
      await deleteChat(chatId);
      setHomeChats((prev) => prev.filter((c) => c.id !== chatId));
      if (nav.homeChatId === chatId) nav.goHomeLanding();
    },
    [nav],
  );

  const requestRemove = useCallback(
    (chatId: string) => setPendingRemove(homeChats.find((c) => c.id === chatId) ?? null),
    [homeChats],
  );

  const value = useMemo<HomeChatsValue>(
    () => ({
      homeChats,
      loading,
      activeHomeChatId: nav.homeChatId,
      draft,
      updateDraft,
      createFromDraft,
      rename,
      setModel,
      setWebSearch,
      remove,
      requestRemove,
      refresh,
    }),
    [homeChats, loading, nav.homeChatId, draft, updateDraft, createFromDraft, rename, setModel, setWebSearch, remove, requestRemove, refresh],
  );

  return (
    <HomeChatsContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Delete this chat?"
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const chat = pendingRemove;
          setPendingRemove(null);
          if (chat) remove(chat.id).catch((err) => console.error("[rama] failed to delete Home chat", err));
        }}
      >
        “{pendingRemove?.title}” and everything in it will be gone for good.
      </ConfirmDialog>
    </HomeChatsContext.Provider>
  );
}

export function useHomeChats(): HomeChatsValue {
  const ctx = useContext(HomeChatsContext);
  if (!ctx) throw new Error("useHomeChats must be used within a HomeChatsProvider");
  return ctx;
}

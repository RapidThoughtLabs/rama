import { useHomeChats } from "../data/HomeChatsProvider";
import { useNavigation } from "../data/NavigationProvider";
import { ChatTitle } from "../shell/ChatTitle";
import { HomeChat } from "./HomeChat";
import { HomeLanding } from "./HomeLanding";
import "./home.css";

/* The Home section's main area — HOME_REDESIGN_PLAN.md Phases HD5/HD6: the landing, or the open
   chat (homeView/homeChatId live in NavigationProvider). */
export function HomeView() {
  const nav = useNavigation();
  return nav.homeView === "chat" && nav.homeChatId ? <HomeChat key={nav.homeChatId} /> : <HomeLanding />;
}

/* The top bar's content for Home: the open chat's title button (mock:L174, 1880). Nothing on the
   landing. */
export function HomeTopbar() {
  const nav = useNavigation();
  const { homeChats, rename, requestRemove } = useHomeChats();
  const chat = nav.homeView === "chat" ? homeChats.find((c) => c.id === nav.homeChatId) : undefined;
  if (!chat) return null;
  return <ChatTitle title={chat.title} onRename={(title) => rename(chat.id, title)} onDelete={() => requestRemove(chat.id)} />;
}

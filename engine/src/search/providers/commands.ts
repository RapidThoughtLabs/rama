import type { SearchProvider, SearchResultItem } from "../types";

// Deliberately thin — same "seam, not the real thing" framing as the rest of rama search. The
// client (ChatColumn.tsx) executes these by switching on `id`; no protocol changes needed to add
// more later.
const COMMANDS: SearchResultItem[] = [
  { id: "cmd:mode:agent", domain: "commands", title: "mode: agent", subtitle: "switch this chat to agent mode", score: 0 },
  { id: "cmd:mode:plan", domain: "commands", title: "mode: plan", subtitle: "switch this chat to plan mode", score: 0 },
  { id: "cmd:mode:ask", domain: "commands", title: "mode: ask", subtitle: "switch this chat to ask mode", score: 0 },
  { id: "cmd:clear", domain: "commands", title: "clear", subtitle: "clear the composer", score: 0 },
];

export const commandsSearchProvider: SearchProvider = {
  domain: "commands",
  label: "Commands",
  list(): SearchResultItem[] {
    return COMMANDS;
  },
};

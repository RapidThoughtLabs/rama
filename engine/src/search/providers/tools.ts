import { createTools } from "../../tools";
import type { SearchCtx, SearchProvider, SearchResultItem } from "../types";

// The throwaway ToolCtx below never runs a tool — only `.description` is read off each entry —
// so an empty chatId and a fresh, never-triggered AbortSignal are safe placeholders. Reusing
// createTools() here (rather than duplicating each tool's description) keeps this provider's
// listing in sync with the real tool catalog for free.
export const toolsSearchProvider: SearchProvider = {
  domain: "tools",
  label: "Tools",
  list(ctx: SearchCtx): SearchResultItem[] {
    const tools = createTools({
      chatId: "",
      projectId: ctx.projectId ?? "",
      projectPath: ctx.projectPath ?? "",
      mode: "ask",
      abortSignal: new AbortController().signal,
    });

    return Object.entries(tools).map(([name, def]) => ({
      id: `tool:${name}`,
      domain: "tools",
      title: name,
      subtitle: (def as { description?: string }).description,
      score: 0,
    }));
  },
};

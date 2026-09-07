import type { LanguageModel } from "ai";
import { createCheckpointer } from "../../checkpoints";
import { createDiagnosticRunner } from "../../diagnostics";
import { createHekuTools } from "../../heku/tools";
import { createReadTracker } from "../../tools/readTracker";
import { createShellSession } from "../../tools/shell";
import { createTools } from "../../tools";
import type { SearchCtx, SearchProvider, SearchResultItem } from "../types";

// The throwaway ToolCtx below never runs a tool — only `.description` is read off each entry —
// so an empty chatId and a fresh, never-triggered AbortSignal are safe placeholders (the real
// reads/checkpoints factories do no I/O until one of their methods is actually called, which
// never happens here). Reusing createTools() here (rather than duplicating each tool's
// description) keeps this provider's listing in sync with the real tool catalog for free.
export const toolsSearchProvider: SearchProvider = {
  domain: "tools",
  label: "Tools",
  list(ctx: SearchCtx): SearchResultItem[] {
    const chatId = "";
    const projectPath = ctx.projectPath ?? "";
    const toolCtx = {
      chatId,
      projectId: ctx.projectId ?? "",
      projectPath,
      mode: "ask" as const,
      abortSignal: new AbortController().signal,
      runId: "",
      reads: createReadTracker(chatId, projectPath),
      checkpoints: createCheckpointer(projectPath),
      shell: createShellSession(projectPath),
      diagnostics: createDiagnosticRunner(projectPath),
      // TL6 — `explore` reads this off ctx but never runs here either; same "never actually
      // invoked" placeholder reasoning as the fields above.
      languageModel: "placeholder" as unknown as LanguageModel,
    };
    const tools = {
      ...createTools(toolCtx),
      // TL7 — heku_find/heku_call plus any currently-promoted tool, same reasoning as above:
      // createHekuTools is a synchronous sqlite read, never touches the placeholder connection.
      ...createHekuTools(toolCtx),
    };

    return Object.entries(tools).map(([name, def]) => ({
      id: `tool:${name}`,
      domain: "tools",
      title: name,
      subtitle: (def as { description?: string }).description,
      score: 0,
    }));
  },
};

import { createBashTool } from "./bash";
import { createBrowserTool } from "./browser";
import { createCheckTool } from "./check";
import { createClarifyTool } from "./clarify";
import { createEditTool } from "./edit";
import { createExploreTool } from "./explore";
import { createFileOpTool } from "./fileOp";
import { createGitTool } from "./git";
import { createGitWriteTool } from "./gitWrite";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createOutlineTool } from "./outline";
import { createProcessTool } from "./process";
import { createReadTool } from "./read";
import { createReviewTool } from "./review";
import { createTestTool } from "./test";
import { createTodoTool } from "./todo";
import { createTreeTool } from "./tree";
import type { ToolCtx } from "./types";
import { createWriteTool } from "./write";

export function createTools(ctx: ToolCtx) {
  return {
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    file_op: createFileOpTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    tree: createTreeTool(ctx),
    outline: createOutlineTool(ctx),
    bash: createBashTool(ctx),
    // docs/MISSION_CONTROL_PLAN.md §7.3 / §8 Phase M4 — the counterpart to `bash background:true`.
    process: createProcessTool(ctx),
    // docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `web` PermissionTool's first (and, so far,
    // only) tool.
    browser: createBrowserTool(ctx),
    git: createGitTool(ctx),
    git_write: createGitWriteTool(ctx),
    check: createCheckTool(ctx),
    todo: createTodoTool(ctx),
    // docs/PROMPT_STACK_PLAN.md §8.1/§8.2 (PS6) — always available, any mode: stopWhen's
    // hasToolCall("clarify") (loop.ts) ends the run right after this is called.
    clarify: createClarifyTool(ctx),
    // docs/PROMPT_STACK_PLAN.md §6.4 (PS5) — the sub-agent roster: explore (read-only, no diff),
    // review (read-only, diff + repo, not the conversation), test (diff + repo, test-files-only
    // write). All three run on ctx.subagentModel, not the parent's own.
    explore: createExploreTool(ctx),
    review: createReviewTool(ctx),
    test: createTestTool(ctx),
  };
}

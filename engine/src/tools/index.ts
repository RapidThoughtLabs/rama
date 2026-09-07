import { createBashTool } from "./bash";
import { createBrowserTool } from "./browser";
import { createCheckTool } from "./check";
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
    explore: createExploreTool(ctx),
  };
}

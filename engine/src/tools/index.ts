import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import type { ToolCtx } from "./types";
import { createWriteTool } from "./write";

export function createTools(ctx: ToolCtx) {
  return {
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    grep: createGrepTool(ctx),
    ls: createLsTool(ctx),
    bash: createBashTool(ctx),
  };
}

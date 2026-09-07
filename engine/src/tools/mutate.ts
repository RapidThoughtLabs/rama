import { gate } from "../agent/permissions";
import type { ToolCtx, ToolResult, ToolRisk } from "./types";

// docs/TOOL_LAYER_PLAN.md §3.4 — checkpointing lives here, not inside gate(): permission and
// recovery are different concerns, and conflating them makes both harder to test. Every mutating
// tool (edit, write, file_op) wraps its run() in this instead of calling gate() directly.
export async function mutate(
  ctx: ToolCtx,
  opts: { name: string; input: unknown; risk: ToolRisk; paths: string[] },
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return gate(ctx, opts, async () => {
    const checkpointId = await ctx.checkpoints.snapshot(`${opts.name} ${opts.paths[0] ?? ""}`);
    const result = await run();
    ctx.reads.invalidate(result.meta?.filesWritten ?? opts.paths);
    return { ...result, meta: { ...result.meta, checkpointId } };
  });
}

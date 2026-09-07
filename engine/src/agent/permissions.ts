import { newId } from "../db/ids";
import { broadcast } from "../ws";
import type { ToolCtx, ToolResult, ToolRisk } from "../tools/types";

// Pending `ask`-mode approvals, keyed by reqId — resolved from server.ts's approvePermission
// WS handler, or auto-denied if the run's AbortController fires while we're waiting.
const pending = new Map<string, (approve: boolean) => void>();

export function requestPermission(
  chatId: string,
  tool: string,
  input: unknown,
  risk: ToolRisk,
  abortSignal: AbortSignal,
): Promise<boolean> {
  const reqId = newId();
  broadcast(chatId, { type: "permission.request", reqId, tool, input, risk });
  broadcast(chatId, { type: "status", state: "waiting_permission", verb: `waiting for approval: ${tool}` });

  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      pending.delete(reqId);
      resolve(false);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    pending.set(reqId, (approve) => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve(approve);
    });
  });
}

export function resolvePermission(reqId: string, approve: boolean): void {
  const resolver = pending.get(reqId);
  if (!resolver) return;
  pending.delete(reqId);
  resolver(approve);
}

// docs/HARNESS_DESIGN.md T5 — "independent read-only calls run in parallel; writes serialise."
// The AI SDK already runs every tool call in a step through Promise.all, so low-risk calls are
// concurrent for free; without this, two high-risk calls issued in the same step (e.g. two
// `edit`s) would race each other's checkpoint/read-tracker bookkeeping. Keyed per chat, not
// globally, so two different chats' high-risk calls never wait on each other.
const highRiskChain = new Map<string, Promise<unknown>>();

function serializeHighRisk<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const previous = highRiskChain.get(chatId) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const chained = previous.then(() => next);
  highRiskChain.set(chatId, chained);

  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      releaseNext();
      // Only the last call in the chain removes the entry — an earlier call racing this
      // `finally` against a newer one already queued behind it must never delete a chain
      // another call is still waiting on.
      if (highRiskChain.get(chatId) === chained) highRiskChain.delete(chatId);
    }
  });
}

async function runSafely(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

// Mode/risk gate: agent = auto, plan = read-only (high-risk hard-blocked, no prompt), ask =
// confirm each high-risk call. Never throws — a block/denial is a normal ToolResult so the
// model can see it and adapt, and `run()`'s own errors are caught here too for the same reason.
export async function gate(
  ctx: ToolCtx,
  opts: { name: string; input: unknown; risk: ToolRisk },
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (opts.risk === "high") {
    if (ctx.mode === "plan") {
      return { ok: false, summary: "blocked: plan mode is read-only" };
    }
    if (ctx.mode === "ask") {
      const approved = await requestPermission(ctx.chatId, opts.name, opts.input, opts.risk, ctx.abortSignal);
      if (!approved) return { ok: false, summary: "denied by user" };
      broadcast(ctx.chatId, { type: "status", state: "tool", verb: `running ${opts.name}` });
    }
    return serializeHighRisk(ctx.chatId, () => runSafely(run));
  }

  return runSafely(run);
}

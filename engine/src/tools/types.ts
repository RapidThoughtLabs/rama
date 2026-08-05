import type { ChatMode } from "@rama/protocol";

// Every tool resolves to this shape, success or failure — a denial or a plan-mode block is
// something the model reads and reacts to next step, not a thrown error that kills the run.
export interface ToolResult {
  ok: boolean;
  summary: string;
  detail?: string;
  artifactId?: string;
}

export interface ToolCtx {
  chatId: string;
  projectId: string;
  projectPath: string;
  mode: ChatMode;
  abortSignal: AbortSignal;
}

export type ToolRisk = "low" | "high";

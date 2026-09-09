import type { ChatMode } from "@rama/protocol";
import type { LlmClient } from "../llm/types";
import type { Checkpointer } from "../checkpoints";
import type { DiagnosticRunner } from "../diagnostics";
import type { ReadTracker } from "./readTracker";
import type { ShellSession } from "./shell";

// Every tool resolves to this shape, success or failure — a denial or a plan-mode block is
// something the model reads and reacts to next step, not a thrown error that kills the run.
export interface ToolResult {
  ok: boolean;
  /** For the model. The only field routed into the message stream — never claim this went
   *  somewhere (e.g. "added to context") that `content` itself doesn't actually reach. */
  content?: string;
  /** For the UI chip. One line. Never sent to the model. */
  summary: string;
  /** For the artifacts panel. Never sent to the model. */
  artifactId?: string;
  meta?: ToolResultMeta;
}

// Structured side-channel data a tool can attach without smuggling it into `content` as prose.
// Every field is optional and most go unpopulated until the phase that produces them (checkpoints:
// TL2, diagnostics: TL5) — the shape lands now so later phases add data, not new plumbing.
export interface ToolResultMeta {
  truncated?: {
    shown: number;
    total: number;
    unit: "lines" | "bytes" | "matches" | "entries";
    how: string;
  };
  diagnostics?: Diagnostic[];
  checkpointId?: string;
  filesRead?: FileStamp[];
  filesWritten?: string[];
  durationMs?: number;
  externalTool?: { server: string; tool: string };
}

export interface Diagnostic {
  file: string;
  line: number;
  col?: number;
  severity: "error" | "warning";
  message: string;
  code?: string;
  source: "tsc" | "eslint" | "biome" | "test" | "build" | string;
}

export interface FileStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ToolCtx {
  chatId: string;
  projectId: string;
  projectPath: string;
  mode: ChatMode;
  abortSignal: AbortSignal;

  // docs/TOOL_LAYER_PLAN.md §3.2 — constructed once per run in agent/loop.ts and threaded into
  // createTools(ctx) exactly like the fields above.
  runId: string;
  reads: ReadTracker;
  checkpoints: Checkpointer;
  shell: ShellSession; // TL3, §5.5
  diagnostics: DiagnosticRunner; // TL5, §5.4
  // LM3 — in-house transport client for the parent turn's model
  llmClient: LlmClient;
  // Subagent model client and model name
  subagentClient: LlmClient;
  subagentModel: string;
}

export type ToolRisk = "low" | "high";

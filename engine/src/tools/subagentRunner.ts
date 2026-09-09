// engine/src/tools/subagentRunner.ts
//
// In-house subagent runner driven by LlmClient instead of AI SDK's streamText.
// docs/LOOP_MIGRATION_PLAN.md LM3

import { createArtifact } from "../db/artifacts";
import type { WireMessage, WireTool } from "../llm/types";
import type { RamaToolSet } from "./define";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

export const SUBAGENT_RETURN_CONTRACT =
  "Before answering, restate the question or task in one line, so it's clear you answered the one " +
  "actually asked. Cite a real file path (and line number where it matters, e.g. `src/foo.ts:42`) for " +
  "every claim — never paraphrase from memory or guess at a path you have not actually seen in a tool " +
  "result. If the briefing you were given includes prior findings or established facts, treat them as " +
  "authoritative — don't re-derive what's already known. You have a fixed step budget for this run; if " +
  "you are not converging, say so rather than spending it all and returning nothing. End with your " +
  "confidence in the answer and, explicitly, what you did NOT check — that is what lets the caller " +
  "decide whether to trust the result or spend a step re-verifying it.";

export interface SubagentRunOptions {
  ctx: ToolCtx;
  toolCallId: string;
  model?: string;
  system: string;
  userContent: string;
  tools: RamaToolSet;
  stepBudget: number;
  answerMaxChars: number;
  /** Tags console error logs and the artifact name prefix, e.g. "explore", "review", "test". */
  logTag: string;
  artifactName: string;
  summaryLabel: string;
  noAnswerMessage: string;
}

export async function runSubagent(opts: SubagentRunOptions): Promise<ToolResult> {
  const {
    ctx,
    toolCallId,
    system,
    userContent,
    tools,
    stepBudget,
    answerMaxChars,
    logTag,
    artifactName,
    summaryLabel,
    noAnswerMessage,
  } = opts;
  const transcript: string[] = [userContent];
  let finalText = "";

  const wireTools: WireTool[] = Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));

  const messages: WireMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  try {
    let steps = 0;
    while (steps < stepBudget) {
      steps++;
      let stepText = "";
      const queuedCalls: { id: string; name: string; input: unknown }[] = [];

      for await (const event of ctx.subagentClient.stream({
        model: opts.model ?? ctx.subagentModel,
        messages,
        tools: wireTools.length > 0 ? wireTools : undefined,
        signal: ctx.abortSignal,
      })) {
        if (event.type === "text.delta") {
          stepText += event.text;
        } else if (event.type === "tool_call") {
          queuedCalls.push(event);
          transcript.push(`\n> ${event.name}(${JSON.stringify(event.input)})`);
        }
      }

      if (stepText) {
        finalText += stepText;
      }

      if (queuedCalls.length === 0) {
        break; // model is finished
      }

      messages.push({
        role: "assistant",
        content: stepText,
        toolCalls: queuedCalls,
      });

      for (const call of queuedCalls) {
        const tool = tools[call.name];
        let output: ToolResult;
        if (!tool) {
          output = { ok: false, summary: "unknown tool", content: `No tool named "${call.name}".` };
        } else {
          try {
            const raw = await tool.execute(call.input, { toolCallId: call.id });
            if (raw && typeof raw === "object" && "ok" in raw && "summary" in raw) {
              output = raw as ToolResult;
            } else {
              output = { ok: true, summary: "ok", content: String(raw) };
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            output = { ok: false, summary: "tool failed", content: `error: ${message}` };
          }
        }

        transcript.push(output.content ?? output.summary);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: output.content ?? output.summary,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${logTag} sub-run failed`, content: `${logTag} failed: ${message}` };
  }

  const answer = finalText.trim() || noAnswerMessage;
  transcript.push(`\n--- answer ---\n${answer}`);

  const artifact = createArtifact({
    chatId: ctx.chatId,
    projectId: ctx.projectId,
    toolCallId,
    kind: "doc",
    name: artifactName,
    meta: {},
    body: transcript.join("\n"),
  });

  const { content, truncated } = headTailTruncate(answer, answerMaxChars);
  return {
    ok: true,
    content,
    summary: summaryLabel,
    artifactId: artifact.id,
    meta: truncated
      ? {
          truncated: {
            shown: answerMaxChars,
            total: answer.length,
            unit: "bytes" as const,
            how: "the sub-agent's answer ran long — narrow the request next time",
          },
        }
      : undefined,
  };
}

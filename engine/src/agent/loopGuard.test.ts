// Regression test for the live bug this guards against: a weak/quantized model answering
// "hello" by calling `bash echo Hello World` eight times in a row, once per step, until
// stepCountIs(8) cut it off — see loopGuard.ts's own comment for the observed chat.
import { describe, expect, test } from "bun:test";
import { REPEATED_TOOL_CALL_LIMIT, stuckOnRepeatedToolCall } from "./loopGuard";

function step(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return { toolCalls };
}

describe("stuckOnRepeatedToolCall", () => {
  test("fewer steps than the limit never trips", () => {
    const steps = Array.from({ length: REPEATED_TOOL_CALL_LIMIT - 1 }, () =>
      step([{ toolName: "bash", input: { command: "echo Hello World" } }]),
    );
    expect(stuckOnRepeatedToolCall(steps)).toBe(false);
  });

  test("the same single tool call repeated to the limit trips it", () => {
    const steps = Array.from({ length: REPEATED_TOOL_CALL_LIMIT }, () =>
      step([{ toolName: "bash", input: { command: "echo Hello World" } }]),
    );
    expect(stuckOnRepeatedToolCall(steps)).toBe(true);
  });

  test("only looks at the trailing window, not the whole run", () => {
    const steps = [
      step([{ toolName: "read", input: { path: "a.ts" } }]),
      ...Array.from({ length: REPEATED_TOOL_CALL_LIMIT }, () => step([{ toolName: "bash", input: { command: "echo hi" } }])),
    ];
    expect(stuckOnRepeatedToolCall(steps)).toBe(true);
  });

  test("differing input breaks the streak even with the same tool name", () => {
    const steps = [
      step([{ toolName: "bash", input: { command: "echo one" } }]),
      step([{ toolName: "bash", input: { command: "echo two" } }]),
      step([{ toolName: "bash", input: { command: "echo three" } }]),
    ];
    expect(stuckOnRepeatedToolCall(steps)).toBe(false);
  });

  test("a step with zero or multiple tool calls in the window never counts as a repeat", () => {
    const multiCall = step([
      { toolName: "bash", input: { command: "echo hi" } },
      { toolName: "bash", input: { command: "echo hi" } },
    ]);
    const textOnly = step([]);
    expect(stuckOnRepeatedToolCall([multiCall, multiCall, multiCall])).toBe(false);
    expect(stuckOnRepeatedToolCall([textOnly, textOnly, textOnly])).toBe(false);
  });
});

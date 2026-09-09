// engine/src/llm/sse.test.ts
//
// docs/LOOP_MENDING_PLAN.md MD1/D7 — the generic SSE reader was untested. Covers comment lines,
// keepalives, multi-line buffering across chunk boundaries, and the [DONE] sentinel.

import { describe, expect, test } from "bun:test";
import { readSSE } from "./sse";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSSE(stream)) out.push(data);
  return out;
}

describe("readSSE", () => {
  test("yields data payloads and stops cleanly at [DONE]", async () => {
    const stream = streamFromChunks(["data: {\"a\":1}\n\n", "data: {\"a\":2}\n\n", "data: [DONE]\n\n"]);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  test("skips comment/keepalive lines (: prefix)", async () => {
    const stream = streamFromChunks([": keepalive\n\n", "data: {\"a\":1}\n\n", ": ping\n\n", "data: [DONE]\n\n"]);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  test("skips blank lines between frames", async () => {
    const stream = streamFromChunks(["\n\ndata: {\"a\":1}\n\n\n", "data: [DONE]\n\n"]);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  test("reassembles a data line split across chunk boundaries", async () => {
    const stream = streamFromChunks(['data: {"a":', '1}\n\n', "data: [DONE]\n\n"]);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  test("handles \\r\\n line endings", async () => {
    const stream = streamFromChunks(['data: {"a":1}\r\n\r\n', "data: [DONE]\r\n"]);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  test("stream closes with no [DONE] sentinel — flushes a trailing buffered data line", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n', 'data: {"a":2}']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  test("stream closes with nothing buffered — yields what it has, no trailing garbage", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });
});

// engine/src/llm/sse.ts
//
// Generic Server-Sent Events reader. Yields parsed data payloads, skipping comment
// lines (`:` prefix) and the terminal `[DONE]` sentinel.
// docs/LOOP_MIGRATION_PLAN.md §4.6 — "all: SSE frames that are comments or keepalives"

/**
 * Reads a ReadableStream<Uint8Array> (from fetch response body) and yields the
 * data payload of each valid SSE data frame. Comments and empty lines are skipped;
 * the stream ends cleanly on `data: [DONE]`.
 *
 * This function owns the reader lock and releases it in all exit paths.
 */
export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines; keep the incomplete last chunk in the buffer.
      // SSE allows \r\n or \n line endings.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        // Comment / keepalive — skip
        if (line.startsWith(":")) continue;
        // Blank line (field separator in the SSE spec) — skip
        if (line === "") continue;
        // We only care about `data:` fields
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trimStart();
        // Terminal sentinel — end the generator cleanly
        if (data === "[DONE]") return;

        yield data;
      }
    }

    // Flush anything remaining in the buffer after the stream closes
    if (buffer.startsWith("data:")) {
      const data = buffer.slice(5).trimStart();
      if (data && data !== "[DONE]") yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

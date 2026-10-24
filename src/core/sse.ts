/** Server-sent-events helpers (OpenAI wire format). */

export const SSE_DONE = "data: [DONE]\n\n";

export function encodeSSE(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function encodeSSEError(message: string, hint?: string): string {
  return encodeSSE({
    error: { message, type: "server_error", code: "stream_error", ...(hint ? { hint } : {}) },
  });
}

/**
 * Turn a byte/string stream into successive SSE `data:` payloads.
 *
 * Handles chunk boundaries that split a line or a multi-byte character,
 * ignores comments/blank lines, and yields the raw `data` string (which may be
 * `[DONE]`).
 */
export async function* iterateSSEData(
  stream: AsyncIterable<string | Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      const data = sseLineToData(line);
      if (data !== undefined) yield data;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = sseLineToData(buffer.replace(/\r$/, ""));
    if (data !== undefined) yield data;
  }
}

function sseLineToData(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  return line.slice(5).trimStart();
}

/** Parse an SSE payload into JSON, returning undefined for `[DONE]`/garbage. */
export function parseSSEData(data: string): unknown | undefined {
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

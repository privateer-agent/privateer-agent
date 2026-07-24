/**
 * Minimal SSE (Server-Sent Events) parsing for streamed chat completions.
 * Yields the parsed JSON object from each `data:` line; skips `[DONE]` and
 * unparseable/partial lines. Used by the streaming provider transports.
 */

/** Stream parse: iterate a ReadableStream of bytes, yielding parsed SSE data objects. */
export async function* iterateSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const obj of parseDataLines(lines)) yield obj;
    }
    // Flush any trailing buffered line.
    if (buf.trim()) for (const obj of parseDataLines([buf])) yield obj;
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/** Sync parse: extract SSE data objects from a fully-buffered body (RN fallback). */
export function parseSSEText(text: string): any[] {
  return parseDataLines(text.split('\n'));
}

function parseDataLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const t = line.slice(5).trim();
    if (!t || t === '[DONE]') continue;
    try { out.push(JSON.parse(t)); } catch { /* partial / non-JSON — skip */ }
  }
  return out;
}

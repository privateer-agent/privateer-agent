// The catch-up transcript a controller gets when it (re)attaches.
//
// The app used to get a single "Privateer terminal connected." notice here, and kept
// whatever feed it already held. So a phone that slept through the end of a turn came
// back to a transcript frozen at the moment its socket died — a "Link dropped" marker
// and nothing after it — while the answer sat in the terminal's session. The session
// IS the transcript: this projects its current branch into the same entry kinds the
// live feed uses, so the app can replace its stale copy with the real one.
//
// Pure (no Pi import) so it can be tested against plain entry objects.

export interface SnapshotTool {
  id: string;
  name: string;
  input: string;
  output?: string;
  error?: string;
  // No result in the session yet: the call is running right now (or the turn was cut
  // off mid-call, which `running: false` on the frame tells the app to settle).
  running?: boolean;
}

export interface SnapshotEntry {
  kind: "you" | "assistant" | "reasoning" | "tool" | "notice";
  text: string;
  tool?: SnapshotTool;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : p?.type === "image" ? "[image]" : ""))
    .join("");
}

/**
 * Session entries (SessionManager.getBranch(), root → leaf) → feed entries, oldest
 * first. Tool calls are paired with their results by id into one entry, the way the
 * live feed settles a card in place. Entries that carry nothing a reader would see
 * (model/thinking-level changes, labels, custom state) are skipped.
 */
export function transcriptSnapshot(entries: readonly any[]): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  const toolAt = new Map<string, number>();
  for (const e of entries) {
    if (e?.type === "compaction") {
      out.length = 0; // what came before is no longer the conversation the agent has
      toolAt.clear();
      out.push({ kind: "notice", text: "Earlier conversation was compacted." });
      continue;
    }
    if (e?.type !== "message") continue;
    const m = e.message;
    switch (m?.role) {
      case "user": {
        const text = partsText(m.content).trim();
        if (text) out.push({ kind: "you", text });
        break;
      }
      case "assistant": {
        for (const p of Array.isArray(m.content) ? m.content : []) {
          if (p?.type === "text" && String(p.text ?? "").trim()) out.push({ kind: "assistant", text: String(p.text) });
          else if (p?.type === "thinking" && !p.redacted && String(p.thinking ?? "").trim()) {
            out.push({ kind: "reasoning", text: String(p.thinking) });
          } else if (p?.type === "toolCall" && p.id) {
            const input = asText(p.arguments ?? {});
            toolAt.set(String(p.id), out.length);
            out.push({
              kind: "tool",
              text: `▸ ${p.name}${input ? `  ${input}` : ""}`,
              tool: { id: String(p.id), name: String(p.name ?? ""), input, running: true },
            });
          }
        }
        if (m.stopReason === "error" && typeof m.errorMessage === "string" && m.errorMessage) {
          out.push({ kind: "notice", text: `⚠ ${m.errorMessage}` });
        }
        break;
      }
      case "toolResult": {
        const at = toolAt.get(String(m.toolCallId));
        const text = partsText(m.content);
        if (at === undefined) break; // a result whose call was compacted away
        const entry = out[at];
        const tool = { ...entry.tool!, running: false };
        if (m.isError) tool.error = text;
        else tool.output = text;
        out[at] = { ...entry, text: `${entry.text}\n  ↳ ${text}`, tool };
        break;
      }
    }
  }
  return out;
}

// Pure logic behind the prompt input: mode detection and autocomplete matching.
// Kept free of Ink so it can be unit-tested directly.

export type InputMode = "bash" | "memory" | "command" | "prompt";

// What the leading character of the buffer means. `!` shells out, `#` appends to
// project memory, `/` runs a slash command, anything else is a model prompt.
export function detectMode(value: string): InputMode {
  switch (value[0]) {
    case "!":
      return "bash";
    case "#":
      return "memory";
    case "/":
      return "command";
    default:
      return "prompt";
  }
}

// The command-name fragment being typed, when the cursor sits within the first
// word of a leading "/command". Null once the user moves on to typing arguments.
export function slashQuery(value: string, cursor: number): string | null {
  if (value[0] !== "/") return null;
  const firstSpace = value.indexOf(" ");
  const nameEnd = firstSpace === -1 ? value.length : firstSpace;
  if (cursor > nameEnd) return null;
  return value.slice(1, nameEnd);
}

// The @-mention token under the cursor: the '@' index plus the text typed after
// it. Requires the '@' to start a word (so emails like a@b don't trigger it).
export function mentionAt(value: string, cursor: number): { start: number; query: string } | null {
  let i = cursor;
  while (i > 0 && !/\s/.test(value[i - 1])) i--;
  if (value[i] !== "@") return null;
  return { start: i, query: value.slice(i + 1, cursor) };
}

export interface CommandItem {
  name: string;
  summary: string;
}

export function filterCommands(all: CommandItem[], query: string): CommandItem[] {
  const q = query.toLowerCase();
  return all.filter((c) => c.name.toLowerCase().startsWith(q));
}

// Substring file match, ranked: basename hits beat path hits, earlier and shorter
// paths win. Keeps the menu small and relevant on large trees.
export function filterFiles(all: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, limit);
  const scored: { f: string; score: number }[] = [];
  for (const f of all) {
    const lower = f.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const baseIdx = base.indexOf(q);
    const score = (baseIdx === -1 ? 1000 : baseIdx) + idx * 0.01 + f.length * 0.001;
    scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.f);
}

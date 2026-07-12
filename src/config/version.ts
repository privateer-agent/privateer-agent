import { createRequire } from "node:module";

// The privateer-agent package version, read once from package.json. Used for the
// relay `context` frame so the app's session banner can show the real agent
// version. Returns "" if unreadable (never throws) — the app just omits the row.
let cached: string | null = null;
export function agentVersion(): string {
  if (cached === null) {
    try {
      cached = String(createRequire(import.meta.url)("../../package.json").version ?? "");
    } catch {
      cached = "";
    }
  }
  return cached;
}

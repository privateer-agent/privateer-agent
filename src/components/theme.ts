import type { PermissionMode } from "../config/schema.ts";

// Single source of truth for TUI color. Privateer's navy/white identity drives the
// accent: it marks bullets, the prompt prefix, headings, and the active permission
// mode. Text is the terminal default (white on dark); metadata is dimmed gray.
//
// Note on navy: a true navy (#1e3a5f) is too dark to read on dark terminals, so the
// accent is a brighter navy/indigo. It's one knob — tune it here and the whole UI
// follows.
export const theme = {
  accent: "#5c7cfa", // Privateer navy/indigo — the single accent hue
  accentDim: "#3b5b8c",
  text: undefined as string | undefined, // terminal default
  dim: "gray",
  success: "green",
  error: "red",
  warning: "yellow",
  diffAdded: "green",
  diffRemoved: "red",
} as const;

// Permission-mode accent colors (moved here from StatusBar so color lives in one place).
export const MODE_COLOR: Record<PermissionMode, string> = {
  default: theme.warning,
  acceptEdits: theme.success,
  bypass: theme.error,
  plan: theme.accent,
};

// Capitalized tool display names: read → Read, web_fetch → WebFetch.
const TOOL_DISPLAY: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  bash_output: "BashOutput",
  kill_shell: "KillShell",
  todo: "TodoWrite",
  task: "Task",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

export const toolDisplayName = (name: string): string => TOOL_DISPLAY[name] ?? name;

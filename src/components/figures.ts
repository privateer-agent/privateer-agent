// Unicode figures used as markers and status glyphs across the TUI.
export const BULLET = "⏺"; // U+23FA — prefixes assistant messages and tool calls
export const TREE = "⎿"; // U+23BF — connects a tool's result under its call
export const BRANCH = "├"; // tee — a non-final child in the grouped agents tree
export const CORNER = "└"; // elbow — the final child in a tree
export const VLINE = "│"; // vertical — continues the trunk past a non-final child
export const WELCOME = "✻"; // U+273B — teardrop-asterisk welcome mark
export const EFFORT = { low: "○", medium: "◐", high: "●", max: "◉" } as const;
export const POINTER = "❯"; // selection pointer in menus and the prompt caret
export const FAST_FORWARD = "⏵⏵"; // marks an "on" permission mode below the prompt
export const PAUSE = "⏸"; // marks plan mode (paused execution) below the prompt
export const SHIELD = "⛉"; // U+26C9 — privacy badge: TEE/ZDR markers in the pickers and the status bar
export const DOT = "●"; // U+25CF — "live" marker; the remote-access badge in the status bar
export const DOWN = "↓"; // U+2193 — output tokens streaming down from the model (spinner)
export const KEY = "⚿"; // U+26BF — "no key" tag on unconfigured key providers in the model picker
export const ARROW = "→"; // U+2192 — "sign in" call-to-action on the signed-out Privateer row

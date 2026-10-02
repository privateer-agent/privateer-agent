// `terminal` — open, focus, list and close named terminal windows the user can see.
// The machinery and its limits are in src/terminals/; this is the model-facing surface.
//
// The gate (permissions/classify.ts) treats `open` with a command exactly like bash —
// it IS running that command, just in a window the user watches — and `close` as
// bash-kind too, since it ends whatever runs there. `focus` and `list` are not gated:
// they change which window is in front and read a list of names.

import { Type } from "typebox";
import {
  closeTerminal,
  describeListing,
  focusTerminal,
  openTerminal,
  terminalListing,
} from "../terminals/index.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

const ACTIONS = ["open", "focus", "list", "close"] as const;
type Action = (typeof ACTIONS)[number];

export const terminalToolDefinition = {
  name: "terminal",
  label: "Terminal",
  description:
    "Open, switch between, list and close named terminal windows on the user's screen. " +
    "`open` starts a new window with a name (and optionally a command, typed into its shell — a dev server, " +
    "a REPL, a log tail, another `privateer`), and gives it focus unless focus is false. `focus` brings a named " +
    "terminal to the front — including the one you are running in (see `list`), so you can send the user back. " +
    "`list` shows every named terminal and marks this one. `close` closes a window and ends what runs in it. " +
    "You can NOT read a terminal's output: for commands whose output you need, use bash or a background task. " +
    "Use this when the user wants to watch or use something themselves, or asks to switch terminals. " +
    "Works in macOS Terminal, iTerm2, Git Bash's own window (mintty) on Windows, and inside tmux. " +
    "Don't improvise with bash (`start`, `mintty`, `open -a`) when this says it can't: tell the user instead.",
  parameters: Type.Object({
    action: Type.Union(ACTIONS.map((a) => Type.Literal(a)), { description: "What to do." }),
    name: Type.Optional(
      Type.String({ description: "The terminal's name — required for open, focus and close. Short: \"api\", \"tests\"." }),
    ),
    command: Type.Optional(Type.String({ description: "open: a shell command to run in the new window." })),
    cwd: Type.Optional(Type.String({ description: "open: the folder to start in. Defaults to the current one." })),
    focus: Type.Optional(Type.Boolean({ description: "open: bring the new window to the front (default true)." })),
  }),
  async execute(
    _id: string,
    params: { action: Action; name?: string; command?: string; cwd?: string; focus?: boolean },
    _signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: any,
  ) {
    if (ctx && ctx.hasUI === false) return text("Terminal windows need an interactive session on the user's machine.");
    const cwd = String(ctx?.cwd ?? process.cwd());
    const name = String(params.name ?? "").trim();
    const action: Action = ACTIONS.includes(params.action) ? params.action : "list";
    if (action !== "list" && !name) return text(`Error: name is required for ${action}.`);
    switch (action) {
      case "open":
        return text(
          (
            await openTerminal({
              name,
              cwd: params.cwd?.trim() || cwd,
              ...(params.command?.trim() ? { command: params.command } : {}),
              ...(params.focus === false ? { focus: false } : {}),
            })
          ).message,
        );
      case "focus":
        return text((await focusTerminal(name, cwd)).message);
      case "close":
        return text((await closeTerminal(name, cwd)).message);
      case "list": {
        const l = await terminalListing(cwd);
        return text("unsupported" in l ? l.unsupported : describeListing(l));
      }
    }
  },
};

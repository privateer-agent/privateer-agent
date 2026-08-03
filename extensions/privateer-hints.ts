// Rotating tips in the working line. While the agent streams, the "Working..."
// loader is dead air for seconds at a time — the one spot a discoverability hint
// costs no vertical space and interrupts nothing. So while a turn is active we
// rotate short tips through it for the keys and commands nobody finds on their
// own: ctrl+t to hide thinking text (the ask that prompted this), shift+tab for
// the thinking level, @file mentions, /models, and so on.
//
// Mechanics: ctx.ui.setWorkingMessage(msg) both stores the message for the next
// working indicator AND live-updates the one currently on screen (and ONLY the
// "working" kind — Pi's guard means retry/compaction spinners are never touched),
// so a timer can rotate the text mid-stream. Calling it with no argument restores
// Pi's default "Working...", which is what agent_end does. Timers run strictly
// inside agent_start → agent_end, so an idle terminal owns no message at all.
//
// Keys render through pi-coding-agent's keyText, which reads the LIVE keybindings
// singleton the running app configured — a user remap shows the remapped key, and
// each hint carries a fallback for an unbound action. The first tip waits a beat
// (FIRST_MS) so short turns never see one; the cursor is module-lifetime so
// back-to-back turns continue the rotation instead of repeating tip #1.
//
// /hints on|off persists { hints: { enabled } } in ~/.privateer/config.json (ours;
// Pi never reads that file) — read-modify-write, preserving unrelated keys.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { keyText } from "@earendil-works/pi-coding-agent";
import { configPath, globalDir } from "../src/config/paths.ts";

const FIRST_MS = 6_000; // a turn shorter than this never shows a tip
const EVERY_MS = 12_000;

// keyText returns "" for an unbound action and could throw if the keybindings
// singleton isn't initialized yet (headless surfaces) — fall back either way.
function key(binding: Parameters<typeof keyText>[0], fallback: string): string {
  try {
    return keyText(binding) || fallback;
  } catch {
    return fallback;
  }
}

// Lazy thunks, not strings: keys resolve at display time, after the app has
// loaded (and possibly remapped) its keybindings.
const HINTS: Array<() => string> = [
  () => `${key("app.thinking.toggle", "ctrl+t")} hides thinking text — make it stick in /settings`,
  () => `${key("app.thinking.cycle", "shift+tab")} cycles the thinking level`,
  () => `${key("app.message.followUp", "alt+enter")} queues a follow-up without interrupting`,
  () => `${key("app.tools.expand", "ctrl+o")} expands collapsed tool output`,
  () => `type @ to reference a file in your prompt — Tab completes the path`,
  () => `/models picks a model, with TEE/ZDR privacy shields`,
  () => `/init writes a PRIVATEER.md so the agent knows this project`,
  () => `/connect adds MCP connectors to this terminal`,
  () => `${key("app.editor.external", "ctrl+g")} drafts long prompts in your $EDITOR`,
  () => `these tips are /hints — /hints off silences them`,
];

// Default ON: absent file, absent block, or unreadable JSON all mean enabled.
// Only an explicit { hints: { enabled: false } } turns the rotation off.
function hintsEnabled(): boolean {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"))?.hints?.enabled !== false;
  } catch {
    return true;
  }
}

function persistEnabled(enabled: boolean): void {
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* no config yet */
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
  cfg.hints = { ...(cfg.hints ?? {}), enabled };
  try {
    mkdirSync(globalDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    /* best effort — the toggle still holds for this session */
  }
}

export default function privateerHints(pi: any): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uiRef: any;
  let cursor = 0;

  const stop = (restoreDefault: boolean): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (restoreDefault) uiRef?.setWorkingMessage?.();
  };

  const showNext = (): void => {
    const hint = HINTS[cursor % HINTS.length]();
    cursor++;
    uiRef?.setWorkingMessage?.(`Working... · tip: ${hint}`);
    timer = setTimeout(showNext, EVERY_MS);
  };

  pi.on("agent_start", (_e: any, ctx: any) => {
    if (!ctx?.hasUI) return; // headless (print/rpc/harbor): no loader to write to
    uiRef = ctx.ui;
    stop(false); // an interrupted turn can restart without an agent_end between
    if (!hintsEnabled()) return;
    timer = setTimeout(showNext, FIRST_MS);
  });

  pi.on("agent_end", () => stop(true));
  pi.on("session_shutdown", () => stop(false));

  pi.registerCommand?.("hints", {
    description: "Rotating tips in the working line: /hints [on | off]",
    handler: (args: string, ctx: any) => {
      uiRef = ctx?.ui ?? uiRef;
      const sub = String(args ?? "").trim().toLowerCase().split(/\s+/)[0];
      if (sub === "on" || sub === "off") {
        const enabled = sub === "on";
        persistEnabled(enabled);
        if (!enabled) stop(true); // takes effect mid-turn; "on" starts next turn
        ctx?.ui?.notify?.(`Working-line tips ${enabled ? "on" : "off"}.`, "info");
        return;
      }
      ctx?.ui?.notify?.(
        `Working-line tips are ${hintsEnabled() ? "on" : "off"} — /hints on|off to change.`,
        "info",
      );
    },
  });
}

// Named terminals — the `terminal` tool and /term, so the agent can open windows the
// user watches (a dev server, a REPL, a second agent) and either of them can switch
// between those windows by name. See src/terminals/ for how windows are found and why
// only tmux, macOS Terminal and iTerm2 are driven.
//
// Interactive only: the window registers itself at session start, which a harbor or ACP
// host has no window to do, and the tool refuses without a UI.

import { closeTerminal, describeListing, focusTerminal, openTerminal, renameSelf, terminalListing, backend, claimSelf } from "../src/terminals/index.ts";
import { terminalToolDefinition } from "../src/tools/terminal.ts";

const USAGE =
  "/term — pick a terminal to switch to · /term <name> — switch · /term open <name> [command] · " +
  "/term name <name> — rename this one · /term close <name> · /term list";

export default function privateerTerminals(pi: any): void {
  pi.registerTool?.(terminalToolDefinition);

  // Name this window as soon as the session starts, so it can be switched back to from
  // any other — not only after its first /term.
  pi.on?.("session_start", (_e: any, ctx: any) => {
    if (!ctx?.hasUI) return;
    const b = backend();
    if ("unsupported" in b) return;
    void claimSelf(b, ctx.cwd ?? process.cwd()).catch(() => undefined);
  });

  pi.registerCommand?.("term", {
    description: "Switch between named terminals, or open one",
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui?.notify?.(m, kind);
      const cwd = ctx?.cwd ?? process.cwd();
      const [sub = "", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const report = (o: { ok: boolean; message: string }) => notify(o.message, o.ok ? "info" : "warning");

      switch (sub.toLowerCase()) {
        case "": {
          const l = await terminalListing(cwd);
          if ("unsupported" in l) return notify(l.unsupported, "warning");
          const others = l.records.filter((r) => r.id !== l.selfId);
          if (!others.length) return notify(`No other named terminals. ${USAGE}`);
          if (typeof ctx?.ui?.select !== "function") return notify(describeListing(l));
          const labels = others.map((r) => `${r.name}  ${r.command ?? r.cwd}`);
          const picked = await ctx.ui.select("Switch to terminal", labels);
          const rec = picked ? others[labels.indexOf(picked)] : undefined;
          if (rec) report(await focusTerminal(rec.name, cwd));
          return;
        }
        case "list": {
          const l = await terminalListing(cwd);
          return notify("unsupported" in l ? l.unsupported : describeListing(l), "unsupported" in l ? "warning" : "info");
        }
        case "open": {
          const [name, ...cmd] = rest;
          if (!name) return notify("Usage: /term open <name> [command]", "warning");
          return report(await openTerminal({ name, cwd, ...(cmd.length ? { command: cmd.join(" ") } : {}) }));
        }
        case "name":
        case "rename":
          if (!rest.length) return notify("Usage: /term name <name>", "warning");
          return report(await renameSelf(rest.join(" "), cwd));
        case "close":
          if (!rest.length) return notify("Usage: /term close <name>", "warning");
          return report(await closeTerminal(rest.join(" "), cwd));
        case "help":
          return notify(USAGE);
        default:
          // Anything else is a name: /term api, /term "dev server".
          return report(await focusTerminal([sub, ...rest].join(" "), cwd));
      }
    },
  });
}

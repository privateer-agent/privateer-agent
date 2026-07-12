// PRIVATEER.md context loading + the /init command.
//
// Pi natively loads AGENTS.md / CLAUDE.md but its candidate list is hardcoded upstream,
// so PRIVATEER.md would otherwise be ignored. This extension makes PRIVATEER.md a
// first-class context file without patching node_modules:
//
//   1. before_agent_start — discover PRIVATEER.md (global agent dir + cwd ancestors) and
//      append its contents to the turn's system prompt, framed exactly like Pi frames
//      AGENTS.md, so the model treats them identically.
//   2. /init — write a starter PRIVATEER.md into the current directory.
//
// The banner (privateer-brand) shows whether a PRIVATEER.md is loaded and, when none is,
// advertises /init. After /init we emit the shared context-changed signal so that line
// refreshes at once. See src/context.ts for the discovery/formatting details.

import { contextBlock, writeTemplate, emitContextChanged, CONTEXT_BLOCK_MARKER } from "../src/context.ts";

// Honor Pi's own "disable context files" switch, so --no-context-files / -nc silences
// PRIVATEER.md too (not just AGENTS.md/CLAUDE.md) — otherwise the flag would half-work.
const CONTEXT_FILES_DISABLED =
  process.argv.includes("--no-context-files") || process.argv.includes("-nc");

export default function privateerContext(pi: any): void {
  // Inject PRIVATEER.md into every turn's system prompt. The prompt is rebuilt per turn
  // and chained across before_agent_start handlers, so appending here is idempotent for
  // the turn; the marker guard makes it a no-op if an earlier handler already added it.
  pi.on("before_agent_start", (event: any) => {
    if (CONTEXT_FILES_DISABLED) return;
    const cwd = event?.systemPromptOptions?.cwd ?? process.cwd();
    const base: string = event?.systemPrompt ?? "";
    if (base.includes(CONTEXT_BLOCK_MARKER)) return; // already injected this chain
    const block = contextBlock(cwd);
    if (!block) return; // no PRIVATEER.md anywhere — leave the prompt untouched
    return { systemPrompt: base + block };
  });

  // /init — scaffold a PRIVATEER.md in the working directory. Never clobbers an existing
  // one; on success we signal the banner so its "PRIVATEER.md loaded" line updates now
  // (the file is picked up automatically on the next turn — no reload needed).
  pi.registerCommand?.("init", {
    description: "Create a starter PRIVATEER.md project-context file in this directory",
    handler: (_args: string, ctx: any) => {
      try {
        const { path, created } = writeTemplate(process.cwd());
        if (!created) {
          ctx?.ui?.notify?.(`PRIVATEER.md already exists at ${path} — left untouched.`, "info");
          return;
        }
        emitContextChanged();
        ctx?.ui?.notify?.(
          `Created ${path}. Edit it with your project's context — it loads automatically each turn.`,
          "info",
        );
      } catch (e) {
        ctx?.ui?.notify?.(`Could not create PRIVATEER.md: ${(e as Error).message || e}`, "error");
      }
    },
  });
}

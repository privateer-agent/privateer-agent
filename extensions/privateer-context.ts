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

import {
  contextBlock,
  contextStats,
  estimateTokens,
  fmtBytes,
  writeTemplate,
  emitContextChanged,
  CONTEXT_BLOCK_MARKER,
  CONTEXT_MAX_BYTES_ENV,
  RUNTIME_GUIDELINES_MARKER,
  runtimeGuidelinesBlock,
} from "../src/context.ts";

// Honor Pi's own "disable context files" switch, so --no-context-files / -nc silences
// everything this extension injects, not just PRIVATEER.md — otherwise the flag would
// half-work. A user who asks for a bare prompt gets a bare prompt.
const CONTEXT_FILES_DISABLED =
  process.argv.includes("--no-context-files") || process.argv.includes("-nc");

export default function privateerContext(pi: any): void {
  // Inject the runtime guidelines + PRIVATEER.md into every turn's system prompt. The
  // prompt is rebuilt per turn and chained across before_agent_start handlers, so
  // appending here is idempotent for the turn; each marker guard makes its own block a
  // no-op if an earlier handler already added it.
  //
  // ONLY EVER APPEND, AND ONLY RETURN WHEN WE ADDED SOMETHING. Pi chains these handlers
  // and a returned `systemPrompt` REPLACES what the chain has built so far, so both
  // halves matter:
  //
  //   • A host that doesn't populate `event.systemPrompt` must not be handed a prompt
  //     synthesised from "" — that gives back our two blocks as the ENTIRE system prompt
  //     and silently drops the real one. `typeof base !== "string"` is what separates
  //     "here is a prompt to chain onto" (possibly empty, legitimate) from "no field".
  //   • When both markers are already present (a re-entrant chain) we have nothing to
  //     contribute, and undefined leaves what is there alone.
  pi.on("before_agent_start", (event: any) => {
    if (CONTEXT_FILES_DISABLED) return;
    const base = event?.systemPrompt;
    if (typeof base !== "string") return;
    let prompt = base;
    if (!prompt.includes(RUNTIME_GUIDELINES_MARKER)) prompt += runtimeGuidelinesBlock();
    if (!prompt.includes(CONTEXT_BLOCK_MARKER)) {
      const cwd = event?.systemPromptOptions?.cwd ?? process.cwd();
      prompt += contextBlock(cwd); // "" when there is no PRIVATEER.md anywhere
    }
    if (prompt === base) return; // nothing to add — leave the chain alone
    return { systemPrompt: prompt };
  });

  // /context — what the project-context files cost, per turn.
  //
  // The cost of a context file is invisible: it is charged inside the system prompt of
  // every request, so a file that grew to 117 KB reads as "the model got slow", never as
  // "I am sending 34,000 tokens per tool call". This command is the answer to that — it
  // names each file, what reaches the model, and what was left behind.
  pi.registerCommand?.("context", {
    description: "Show the PRIVATEER.md files loaded into every turn, and what they cost",
    handler: (_args: string, ctx: any) => {
      const { files, diskBytes, loadedBytes, truncated, maxBytes } = contextStats(process.cwd());
      if (files.length === 0) {
        ctx?.ui?.notify?.(
          `No PRIVATEER.md found for ${process.cwd()} — /init writes a starter one.`,
          "info",
        );
        return;
      }
      const lines = files.map((f) => {
        const cost = `${fmtBytes(f.loadedBytes)} ≈ ${estimateTokens(f.loadedBytes).toLocaleString()} tokens/turn`;
        const cut = f.truncated ? `  ⚠ TRUNCATED from ${fmtBytes(f.bytes)}` : "";
        return `  ${f.path}\n    ${cost}${cut}`;
      });
      const cap = Number.isFinite(maxBytes)
        ? `${fmtBytes(maxBytes)} per file (${CONTEXT_MAX_BYTES_ENV}=off to load them whole)`
        : `none — ${CONTEXT_MAX_BYTES_ENV} disabled the cap`;
      const total =
        `Total on disk ${fmtBytes(diskBytes)} · sent every turn ${fmtBytes(loadedBytes)} ` +
        `≈ ${estimateTokens(loadedBytes).toLocaleString()} tokens.`;
      const advice = truncated
        ? "\n\nA context file is re-sent in full on every tool call, and confidential (TEE) endpoints cannot cache it — so this is paid again on each one. Split the history out into an ARCHIVE.md the agent reads only when asked."
        : "";
      ctx?.ui?.notify?.(
        `Project context loaded into every turn:\n${lines.join("\n")}\n\n${total}\nCap: ${cap}.${advice}`,
        truncated ? "warning" : "info",
      );
    },
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

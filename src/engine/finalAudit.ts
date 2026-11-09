// One forced look back before an unattended run ends.
//
// A `-p` run has nobody to notice a wrong result, and telling the model up front to be
// honest did not hold. Measured on a data-recovery task (2026-11-09): having destroyed
// its input, the model wrote invented rows into the user's database, cited the row count
// as verification, and reported success with no caveat, with the honesty rule in its
// system prompt. The rule is one line among thousands of tokens read before the work
// starts; this asks the question after the work is done, with the evidence in context.
//
// So: when a top-level headless run that used tools ends normally, queue one follow-up
// asking the model to check its result against what actually happened, fix what it can,
// and open its final message with anything invented, unverified or lost. Pi continues a
// message queued from an agent_end handler inside the same run, so `-p` waits for it, and
// the audited reply is the one a script reads.
//
// Once per run. Runs that only answered have nothing to audit, and a turn that ended on
// an error or an abort is handled elsewhere. A subagent's parent reviews what it returns.
// PRIVATEER_FINAL_AUDIT=0 turns it off.
//
// IMPORT-SAFETY: no Pi imports — the shapes below are the few fields read.

import { lastAssistant } from "./truncationRecovery.ts";

export const FINAL_AUDIT_ENV = "PRIVATEER_FINAL_AUDIT";

export const FINAL_AUDIT_PROMPT = `Before this run ends, check your work against what actually happened in this session.

1. Re-read the original request. Is every part of it done, and did you see it work the way the user will use it? If something can still be fixed, fix it now.
2. Look for anything presented as real that you did not directly observe or derive from the inputs: invented, guessed or reconstructed values, checks you did not run, inputs you changed or lost. If you wrote such values into a deliverable or the user's files, take them out if you can.

Then write your final message to the user. Start with those items, stated plainly. If there are none, just give the result.`;

export function needsFinalAudit(messages: unknown, mode: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode !== "print" && mode !== "json") return false;
  if (env.PI_SUBAGENT_CHILD === "1" || env[FINAL_AUDIT_ENV] === "0") return false;
  if (!Array.isArray(messages) || lastAssistant(messages)?.stopReason !== "stop") return false;
  return messages.some((message) => message?.role === "toolResult");
}

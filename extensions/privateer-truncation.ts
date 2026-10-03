// Keep the agent going when a reply is cut off at the output limit.
//
// A run that ends on a full-budget length stop ("Response was truncated before
// completion.") just stops in stock pi — the agent abandons the task until the user
// types "continue". This queues that follow-up for them, at most MAX_AUTO_CONTINUES
// times in a row. The decision, and why it is shaped this way, lives in
// src/engine/truncationRecovery.ts.

import { MAX_AUTO_CONTINUES, decideTruncationRecovery } from "../src/engine/truncationRecovery.ts";

export default function privateerTruncation(pi: any): void {
  let consecutive = 0;

  // Something the user typed starts a fresh count: giving up once must not disarm
  // recovery for the rest of the session.
  pi.on("input", () => {
    consecutive = 0;
  });

  pi.on("agent_end", (ev: any, ctx: any) => {
    const decision = decideTruncationRecovery(ev?.messages, Number(ctx?.model?.maxTokens) || 0, consecutive);
    if (decision.action === "none") {
      consecutive = 0;
      return;
    }
    if (decision.action === "give-up") {
      ctx?.ui?.notify?.(
        `The reply was cut off at the output limit ${MAX_AUTO_CONTINUES + 1} times in a row — stopped. ` +
          `Type "continue" to try again, lower the thinking level (shift+tab), or pick another model.`,
        "warning",
      );
      return;
    }
    consecutive = decision.attempt;
    ctx?.ui?.notify?.(`Reply cut off at the output limit — continuing (${decision.attempt}/${MAX_AUTO_CONTINUES}).`, "info");
    // Queued from agent_end while the run is still active, so pi continues it in the
    // same run (agent-session _handlePostAgentRun) instead of waiting for the user.
    pi.sendMessage(
      { customType: "privateer-truncation", content: decision.prompt, display: true, details: { attempt: decision.attempt } },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}

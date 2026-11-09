// Makes an unattended run check its result before it ends. The decision, and why it
// exists, lives in src/engine/finalAudit.ts.

import { FINAL_AUDIT_PROMPT, needsFinalAudit } from "../src/engine/finalAudit.ts";

export default function privateerFinalAudit(pi: any): void {
  let audited = false;

  pi.on("agent_end", (ev: any, ctx: any) => {
    if (audited || !needsFinalAudit(ev?.messages, ctx?.mode)) return;
    audited = true;
    pi.sendMessage(
      { customType: "privateer-final-audit", content: FINAL_AUDIT_PROMPT, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}

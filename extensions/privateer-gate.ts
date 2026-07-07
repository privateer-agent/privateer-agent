// The permission gate as a standalone Pi extension, for loading into Pi's own
// interactive TUI via `-e`. Reuses makePermissionGate; approvals render through
// Pi's native UI (ctx.ui) via defaultLocalAsk. A /mode command toggles the mode.
//
// This is how the moat rides on Pi's full TUI (Phase 6) instead of a hand-built one:
// Pi provides transcript/editor/pickers/approval-UI; our extension provides the
// safe-by-default policy.

import { makePermissionGate, defaultLocalAsk } from "../src/ext/permissionGate.ts";
import type { PermissionMode } from "../src/config/permissionMode.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypass", "plan"];
let mode: PermissionMode = MODES.includes(process.env.PRIVATEER_MODE as PermissionMode)
  ? (process.env.PRIVATEER_MODE as PermissionMode)
  : "default";
const allowlist: string[] = [];
const allowedOutsideRoots: string[] = [];

const gate = makePermissionGate({
  getMode: () => mode,
  setMode: (m) => (mode = m),
  allowlist,
  allowedOutsideRoots,
  cwd: process.cwd(),
  localAsk: defaultLocalAsk,
});

export default function privateerGate(pi: any): void {
  gate(pi); // wires the tool_call (block/allow) + tool_result (redact) hooks

  pi.registerCommand?.("mode", {
    description: "Show or set the permission mode: default | acceptEdits | bypass | plan",
    handler: (args: string, ctx: any) => {
      const m = String(args ?? "").trim() as PermissionMode;
      if (m && MODES.includes(m)) mode = m;
      else if (m) return ctx.ui?.notify?.(`unknown mode "${m}" — use ${MODES.join(" | ")}`, "warning");
      ctx.ui?.notify?.(`permission mode: ${mode}`, "info");
    },
  });
}

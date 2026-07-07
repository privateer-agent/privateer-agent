// Privateer-specific custom tools for Pi's TUI (Phase 5). Today: create_routine
// (schedule unattended tasks → the daemon runs them). The generic tools (read/edit/
// bash/grep, web, subagents, todo) come from Pi builtins + adopted packages, so only
// the privateer-only tools live here. Gated by our permission-gate extension.
import { routineToolDefinition } from "../src/tools/routine.ts";

export default function privateerTools(pi: any): void {
  pi.registerTool?.(routineToolDefinition);
}

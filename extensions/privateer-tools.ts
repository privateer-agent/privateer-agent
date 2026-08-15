// Privateer-specific custom tools for Pi's TUI (Phase 5). Today: create_routine
// (schedule unattended tasks → the harbor runs them) and read_routine_result (read
// one back — its standing instruction plus its latest output — so a conversation can
// ACT on what a routine found instead of only being told it ran). The generic tools
// (read/edit/bash/grep, web, subagents, todo) come from Pi builtins + adopted
// packages, so only the privateer-only tools live here. Gated by our permission-gate
// extension.
import { routineToolDefinition } from "../src/tools/routine.ts";
import { routineResultToolDefinition } from "../src/tools/routineResult.ts";

export default function privateerTools(pi: any): void {
  pi.registerTool?.(routineToolDefinition);
  pi.registerTool?.(routineResultToolDefinition);
}

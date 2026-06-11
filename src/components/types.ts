// One rendered line/block in the conversation transcript.
export type ToolStatus = "running" | "done" | "error";

export interface ToolEntry {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
  error?: string;
  // Set only on `task` calls: the sub-agent's short description, its type (undefined =
  // the default read-only explorer), and run metrics filled in when it finishes. Drives
  // the grouped "N agents finished" rendering.
  agent?: { description: string; subagentType?: string; toolUses?: number; tokens?: number };
}

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | ToolEntry
  // `hint` is an optional actionable line rendered dim beneath the notice
  // (used by error notices to suggest a next step).
  | { kind: "notice"; text: string; tone?: "info" | "error"; hint?: string };

// A render-time row: either a single transcript entry, or a run of two-or-more
// concurrent `task` sub-agents collapsed into one grouped block. Grouping happens at
// render time (see groupRows) so the underlying transcript stays a flat entry list.
export interface AgentGroupRow {
  kind: "agent-group";
  agents: ToolEntry[];
}
export type Row = Entry | AgentGroupRow;

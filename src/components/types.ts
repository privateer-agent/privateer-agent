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
}

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | ToolEntry
  | { kind: "notice"; text: string; tone?: "info" | "error" };

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolEntry } from "./types.ts";
import { theme } from "./theme.ts";
import { formatTokens } from "./StatusBar.tsx";
import { BULLET, BRANCH, CORNER, VLINE } from "./figures.ts";

// Title-case a sub-agent type for the header ("code-reviewer" → "Code-reviewer");
// the default read-only explorer (no type) is shown as "Explore", matching the
// stock agent's role.
function agentLabel(subagentType?: string): string {
  if (!subagentType) return "Explore";
  return subagentType.charAt(0).toUpperCase() + subagentType.slice(1);
}

function statusWord(s: ToolEntry["status"]): string {
  return s === "running" ? "Running…" : s === "error" ? "Failed" : "Done";
}

// The grouped "N agents finished" block for a run of concurrent `task` sub-agents,
// modeled on Claude Code's fan-out view: a header summarizing the batch, then one
// tree row per agent with its description, tool-use + token counts, and status.
// Collapsed (the default) shows just status; Ctrl+O expands each agent's full output.
export function AgentGroupView({
  agents,
  collapsed,
}: {
  agents: ToolEntry[];
  collapsed?: boolean;
}) {
  const running = agents.some((a) => a.status === "running");
  const errored = agents.some((a) => a.status === "error");
  // A single shared label when every agent is the same type, else a bare "agents".
  const types = new Set(agents.map((a) => a.agent?.subagentType ?? ""));
  const label = types.size === 1 ? `${agentLabel([...types][0] || undefined)} ` : "";
  const verb = running ? "running" : errored ? "finished (with errors)" : "finished";
  const headColor = running ? theme.accent : errored ? theme.error : theme.success;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        {running ? (
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={headColor}>{BULLET}</Text>
        )}
        <Text>
          <Text bold>
            {agents.length} {label}agent{agents.length === 1 ? "" : "s"} {verb}
          </Text>
          {collapsed && !running && <Text color={theme.dim}> (ctrl+o to expand)</Text>}
        </Text>
      </Box>

      <Box flexDirection="column" marginLeft={2}>
        {agents.map((a, i) => {
          const last = i === agents.length - 1;
          const m = a.agent;
          const metrics =
            a.status !== "running" && m && (m.toolUses != null || m.tokens != null)
              ? ` · ${m.toolUses ?? 0} tool uses · ${formatTokens(m.tokens ?? 0)} tokens`
              : "";
          const trunk = last ? " " : VLINE;
          const body = a.status === "error" ? a.error ?? "" : a.output ?? "";
          const outLines = body.trim() === "" ? [] : body.replace(/\n+$/, "").split("\n");
          return (
            <Box key={a.id} flexDirection="column">
              <Text>
                <Text color={theme.dim}>{last ? CORNER : BRANCH} </Text>
                <Text bold>{m?.description ?? "agent"}</Text>
                <Text color={theme.dim}>{metrics}</Text>
              </Text>
              <Text>
                <Text color={theme.dim}>
                  {trunk} {CORNER}{" "}
                </Text>
                {a.status === "running" ? (
                  <Text color={theme.accent}>
                    <Spinner type="dots" /> {statusWord(a.status)}
                  </Text>
                ) : (
                  <Text color={a.status === "error" ? theme.error : theme.dim} dimColor={a.status !== "error"}>
                    {statusWord(a.status)}
                  </Text>
                )}
              </Text>
              {!collapsed &&
                outLines.map((l, j) => (
                  <Text key={j} color={theme.dim} dimColor>
                    {trunk}
                    {"   "}
                    {l}
                  </Text>
                ))}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

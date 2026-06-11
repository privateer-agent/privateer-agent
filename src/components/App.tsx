import React, { useState, useRef, useEffect, useMemo } from "react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import { Banner } from "./Banner.tsx";
import { StatusBar, formatTokens, formatDuration } from "./StatusBar.tsx";
import { RowView, groupRows } from "./Transcript.tsx";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { PlanConfirm } from "./PlanConfirm.tsx";
import { ModeHint } from "./ModeHint.tsx";
import { useZdrShield } from "./useZdrShield.ts";
import { RewindPicker } from "./RewindPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { CheckpointStore, type RewindScope } from "../memory/checkpoints.ts";
import { ProcessRegistry } from "../tools/processRegistry.ts";
import { HookRunner, loadHooks } from "../hooks/engine.ts";
import type { ToolSet } from "ai";
import { loadMcpServers, connectMcpServers, type McpConnection } from "../mcp/client.ts";
import { hasStoredAuth, clearStoredAuth } from "../mcp/oauth.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { exec } from "../tools/exec.ts";
import { resolveAttachments, chipFor } from "../util/images.ts";
import type { Attachment } from "../util/images.ts";
import { AttachmentStore } from "../util/attachmentStore.ts";
import type { Entry, ToolEntry, Row } from "./types.ts";
import type { TodoStore, TodoItem } from "../tools/todoStore.ts";
import type { Config, PermissionMode } from "../config/schema.ts";
import { createSession } from "../session.ts";
import { QueryEngine } from "../engine/QueryEngine.ts";
import { emptyUsage, type UsageTotals } from "../engine/events.ts";
import { runCommand, commandList } from "../commands/registry.ts";
import { isSlashCommand } from "./promptModel.ts";
import { loadCustomCommands } from "../commands/custom.ts";
import { saveGlobalConfig } from "../config/load.ts";
import { ModeGate, type AskOutcome } from "../permissions/uiGate.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import {
  saveSession,
  loadSession,
  listSessions,
  newSessionId,
  checkpointsDir,
  type SessionData,
  type SessionMeta,
} from "../memory/store.ts";
import { theme } from "./theme.ts";
import { DOWN } from "./figures.ts";
import { randomVerb } from "./spinnerVerbs.ts";

interface PendingApproval {
  req: PermissionRequest;
  resolve: (outcome: AskOutcome) => void;
}

const BANNER = "__banner__";

function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

// Fold a finished sub-agent's run metrics into the entry's existing agent info
// (description/type set at call time), leaving non-task entries untouched.
function mergeAgentMetrics(
  agent: ToolEntry["agent"],
  m?: { toolUses: number; tokens: number },
): ToolEntry["agent"] {
  if (!agent) return agent;
  return { ...agent, toolUses: m?.toolUses, tokens: m?.tokens };
}

// Render the committed transcript as markdown for /export.
function serializeTranscript(entries: Entry[]): string {
  const lines = [`# Privateer transcript`, `_${new Date().toISOString()}_`, ""];
  for (const e of entries) {
    if (e.kind === "user") lines.push(`## You`, "", e.text, "");
    else if (e.kind === "assistant") lines.push(`## Privateer`, "", e.text, "");
    else if (e.kind === "tool") lines.push(`- \`${e.name}\` — ${e.status}`, "");
    else if (e.kind === "notice") lines.push(`> ${e.text}`, "");
  }
  return lines.join("\n");
}

export function App({
  model,
  config: initialConfig,
  cwd,
  resume,
  onLogin,
}: {
  model: string;
  config: Config;
  cwd: string;
  resume?: SessionData | null;
  onLogin?: () => void;
}) {
  // Config is state, not just a prop, so runtime toggles that change request
  // behavior (e.g. /zdr) can update it and trigger a session rebuild.
  const [config, setConfig] = useState<Config>(initialConfig);
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Bumped on resize to remount <Static> (forcing the whole transcript to be
  // re-emitted) as part of a full repaint — see the resize effect below.
  const [resizeNonce, setResizeNonce] = useState(0);
  const [committed, setCommitted] = useState<Entry[]>([]);
  const [live, setLive] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelSpec, setModelSpec] = useState(model);
  const zdr = useZdrShield(modelSpec, config);
  // OpenRouter ZDR enforcement (set via /zdr); rebuilds the session when toggled so
  // the provider preference (provider.zdr) rides on the next turn's requests.
  const zdrEnforced = Boolean(config.providers.openrouter?.enforceZdr);
  const [mode, setMode] = useState<PermissionMode>(config.permissionMode);
  const [usage, setUsage] = useState<UsageTotals>(resume?.usage ?? emptyUsage());
  // Context-window occupancy (Claude-Code-style "% of context") and per-turn cost,
  // shown alongside the cumulative session usage so a one-word message visibly costs
  // little. `turnUsage` ticks live during a turn; `lastTurnUsage` holds the last
  // finished turn's total.
  const [context, setContext] = useState<{ used: number; budget: number }>({ used: 0, budget: 0 });
  const [turnUsage, setTurnUsage] = useState<UsageTotals>(emptyUsage());
  const [lastTurnUsage, setLastTurnUsage] = useState<UsageTotals>(emptyUsage());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [picking, setPicking] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [verb, setVerb] = useState(randomVerb());
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState(0);
  const [vim, setVim] = useState<boolean>(Boolean(config.vim));
  const [outputStyle, setOutputStyle] = useState<string | null>(config.outputStyle ?? null);
  const [planReady, setPlanReady] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [sessionsPicking, setSessionsPicking] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [mcpTools, setMcpTools] = useState<ToolSet>({});
  const mcpRef = useRef<McpConnection | null>(null);
  const [statusText, setStatusText] = useState("");
  // Verbose expands tool output to its full text (truncated to a few lines
  // otherwise). Driven both by `/verbose` and, in tandem with `collapsed`, by
  // the Ctrl+O detail toggle below.
  const [verbose, setVerbose] = useState(false);
  // Collapsed view compacts the model's reasoning blocks to a single line each,
  // so the transcript isn't dominated by thinking. Collapsed (and tool output
  // truncated) is the default resting state; Ctrl+O flips both at once.
  const [collapsed, setCollapsed] = useState(true);
  const engineRef = useRef<QueryEngine | null>(null);
  const todosRef = useRef<TodoStore | null>(null);
  // Stable id for the session being written this run; reused when resuming so a
  // continued session overwrites its own file instead of forking a new one.
  const sessionIdRef = useRef(resume?.id ?? newSessionId());
  const seededRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Input history (↑/↓) and the type-ahead queue for messages entered while busy.
  const historyRef = useRef<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  // Monotonic counter for "[Image #n]" reference chips, shared across the session.
  const imageSeqRef = useRef(0);
  // Attachments the prompt input resolved live (on drag-drop/paste) and already
  // rewrote to chips in the buffer text. Each turn claims the ones whose chip
  // survives into its submitted text, so the base64 still rides along.
  const pendingImagesRef = useRef<Attachment[]>([]);
  // Session-lifetime checkpoint store (survives model/style switches) for /rewind,
  // plus a live mirror of the committed transcript length for checkpointing. Bound to
  // the session's on-disk checkpoint dir so /rewind survives a restart-and-resume; a
  // fresh session loads an empty store from a dir that doesn't exist yet.
  const checkpointsRef = useRef<CheckpointStore>(
    CheckpointStore.load(checkpointsDir(cwd, sessionIdRef.current)),
  );
  const committedRef = useRef<Entry[]>([]);
  // Background-shell registry, shared across the session for bash run_in_background.
  const processesRef = useRef<ProcessRegistry>(new ProcessRegistry());
  // Session-lifetime store of attachment bytes (by "#n"), so the save_attachment tool
  // can write a pasted/dropped file to disk without re-reading the volatile drop path.
  const attachmentsRef = useRef<AttachmentStore>(new AttachmentStore());
  // Run metrics (tool uses + tokens) for `task` sub-agents, keyed by tool-call id and
  // filled in when each agent finishes. Read when its tool-result arrives to annotate
  // the grouped agents view. A plain ref (not state) — it's merged into the entry the
  // result already re-renders.
  const subAgentMetricsRef = useRef<Map<string, { toolUses: number; tokens: number }>>(new Map());

  // The gate reads the live mode via a ref (so changing mode doesn't require
  // rebuilding the session/tools) and surfaces approvals through React state.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const allowlistRef = useRef<string[]>([...config.allowlist]);

  // Custom slash commands from .privateer/commands, plus the merged autocomplete list.
  const customCommands = useMemo(() => loadCustomCommands(cwd), [cwd]);
  const commands = useMemo(() => commandList(customCommands), [customCommands]);
  // Lifecycle hooks (UserPromptSubmit / Stop) configured in settings.
  const hooks = useMemo(() => new HookRunner(loadHooks((config as any).hooks), cwd), [cwd]);

  const gate = useMemo(
    () =>
      new ModeGate({
        getMode: () => modeRef.current,
        setMode: (m) => setMode(m),
        allowlist: allowlistRef.current,
        denylist: config.denylist,
        ask: (req) => new Promise<AskOutcome>((resolve) => setPending({ req, resolve })),
      }),
    [],
  );

  // Build (and rebuild on model / output-style change) the agent session, carrying
  // history forward.
  useEffect(() => {
    try {
      const prev = engineRef.current;
      const prevTodos = todosRef.current?.get() ?? [];
      const session = createSession({
        config,
        modelSpec,
        cwd,
        gate,
        outputStyle: outputStyle ?? undefined,
        planMode: mode === "plan",
        checkpoints: checkpointsRef.current,
        extraTools: mcpTools,
        processes: processesRef.current,
        attachments: attachmentsRef.current,
        onSubAgentMetrics: (id, m) => subAgentMetricsRef.current.set(id, m),
      });
      if (prev) {
        session.engine.messages.push(...prev.messages);
      } else if (!seededRef.current && resume) {
        // First build of a resumed session: restore prior history and usage.
        session.engine.messages.push(...resume.messages);
        session.engine.usage = resume.usage;
      }
      seededRef.current = true;
      engineRef.current = session.engine;
      // Carry the todo list across model switches and keep the panel in sync.
      if (prevTodos.length) session.todos.set(prevTodos);
      todosRef.current = session.todos;
      setTodos(session.todos.get());
      const unsub = session.todos.subscribe(setTodos);
      setSessionError(null);
      return unsub;
    } catch (err) {
      engineRef.current = null;
      setSessionError(err instanceof Error ? err.message : String(err));
    }
    // Rebuild on model/style change, and when entering/leaving plan mode (so the
    // system prompt gains or loses the plan-mode mandate) — not on every mode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSpec, outputStyle, mode === "plan", mcpTools, zdrEnforced]);

  // One-time notice when resuming a prior conversation.
  useEffect(() => {
    if (resume && resume.messages.length > 0) {
      setCommitted((c) => [
        { kind: "notice", text: `Resumed previous session (${resume.messages.length} messages).` },
        ...c,
      ]);
    }
  }, []);

  // Keep a live mirror of the committed transcript so checkpoints can record its
  // length synchronously (the useInput/runTurn closures can lag a render).
  useEffect(() => {
    committedRef.current = committed;
  }, [committed]);

  // Kill any background shells when the app unmounts.
  useEffect(() => {
    const procs = processesRef.current;
    return () => procs.killAll();
  }, []);

  // Repaint cleanly when the terminal is resized.
  //
  // Ink commits the transcript once via <Static> and redraws only the footer
  // below it, erasing the prior frame by its newline count. That count is
  // width-unaware, so when the terminal reflows the previously-printed (always
  // full-width) footer on a narrower drag, Ink under-erases and leaves a stale
  // copy — one per resize event, which stacks into the duplicated status bars.
  // There's no way to stop the terminal reflow, so on resize-settle we wipe the
  // screen + scrollback and remount <Static> to re-emit the whole transcript at
  // the new width. Debounced so it fires once when dragging stops, not per tick.
  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = stdout.columns;
    let lastRows = stdout.rows;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Terminals emit "resize" spuriously (focus changes, refreshes, and on
        // some setups while a drag-selection scrolls the view) without the
        // dimensions actually changing. The wipe below clears the screen *and*
        // scrollback, so firing it on a non-resize destroys any active text
        // selection out from under the user — which reads as the whole screen
        // flashing while idle. Only repaint when the size genuinely changed.
        if (stdout.columns === lastCols && stdout.rows === lastRows) return;
        lastCols = stdout.columns;
        lastRows = stdout.rows;
        stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback, home cursor
        setResizeNonce((n) => n + 1); // remount <Static> → repaint transcript
      }, 120);
    };
    stdout.on("resize", onResize);
    return () => {
      clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Custom status line: run the configured command with session JSON on stdin and use
  // its first line of stdout. Re-runs when the surfaced state changes. Best-effort.
  useEffect(() => {
    const cmd = config.statusLine;
    if (!cmd) return;
    let cancelled = false;
    const payload = JSON.stringify({ model: modelSpec, mode, cwd, tokens: usage.totalTokens });
    void exec(cmd, [], { cwd, timeoutMs: 5_000, shell: true, input: payload }).then((res) => {
      if (!cancelled) setStatusText((res.stdout.split("\n")[0] ?? "").trim());
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSpec, mode, usage.totalTokens]);

  // Connect MCP servers from mcp.json once on mount; their tools merge into the
  // session. Best-effort — failures are reported but never block the app.
  useEffect(() => {
    const servers = loadMcpServers(cwd);
    if (Object.keys(servers).length === 0) return;
    let cancelled = false;
    const onAuthorize = ({ server, url }: { server: string; url: string }) => {
      append({ kind: "notice", text: `MCP "${server}" needs authorization. Opening browser… if it doesn't open, visit:\n${url}` });
    };
    void connectMcpServers(servers, cwd, gate, onAuthorize).then((conn) => {
      if (cancelled) {
        conn.clients.forEach((c) => c.close());
        return;
      }
      mcpRef.current = conn;
      setMcpTools(conn.tools);
      const ok = conn.status.filter((s) => !s.error);
      const failed = conn.status.filter((s) => s.error);
      if (ok.length) {
        const n = ok.reduce((a, s) => a + s.tools, 0);
        append({ kind: "notice", text: `MCP: connected ${ok.length} server(s), ${n} tool(s).` });
      }
      for (const s of failed) {
        append({ kind: "notice", tone: "error", text: `MCP server "${s.server}" failed: ${s.error}` });
      }
    });
    return () => {
      cancelled = true;
      mcpRef.current?.clients.forEach((c) => c.close());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  function persist() {
    const eng = engineRef.current;
    if (!eng) return;
    try {
      saveSession(cwd, sessionIdRef.current, {
        modelSpec,
        messages: eng.messages,
        usage: eng.usage,
      });
    } catch {
      /* non-fatal */
    }
  }

  // Shift+Tab cycles the permission mode in place (like Claude Code), without
  // having to type /permissions. Dangerous bypass sits last so it takes three
  // taps to reach from default.
  const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];
  function cycleMode() {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(modeRef.current) + 1) % MODE_CYCLE.length];
    setMode(next);
    trySave({ ...config, permissionMode: next });
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    // Esc interrupts an in-flight turn (the run loop persists partial output).
    if (key.escape && busy && abortRef.current) abortRef.current.abort();
    // Ctrl+O toggles detail level for the whole transcript: it expands/collapses
    // both the model's reasoning blocks and full tool output together. (Reasoning
    // only exists when extended thinking is enabled, so without also flipping tool
    // output the key would appear to do nothing on a typical session.) The committed
    // transcript lives in <Static>, so force a full repaint to re-render it.
    if (key.ctrl && input === "o") {
      const expanding = collapsed; // currently collapsed → this press expands
      setCollapsed(!expanding);
      setVerbose(expanding);
      stdout?.write("\x1b[2J\x1b[3J\x1b[H");
      setResizeNonce((n) => n + 1);
    }
    // Shift+Tab rotates the permission mode — but not while a modal overlay owns
    // input (it has its own keybindings).
    if (key.tab && key.shift && !pending && !picking && !rewinding && !planReady && !sessionsPicking)
      cycleMode();
  });

  // Drive the elapsed-seconds counter shown beside the spinner while a turn runs.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const append = (...entries: Entry[]) => setCommitted((c) => [...c, ...entries]);

  function handleCommand(raw: string): boolean {
    const res = runCommand(raw, { config, modelSpec, mode, usage, context, cwd, todos, customCommands });
    if (!res) return false;
    append({ kind: "user", text: raw });
    switch (res.type) {
      case "exit":
        exit();
        break;
      case "clear":
        setCommitted([]);
        setLive([]);
        setUsage(emptyUsage());
        if (engineRef.current) {
          engineRef.current.messages.length = 0;
          engineRef.current.usage = emptyUsage();
        }
        todosRef.current?.set([]);
        persist();
        break;
      case "setModel":
        applyModel(res.spec);
        break;
      case "pickModel":
        setPicking(true);
        break;
      case "setMode":
        setMode(res.mode);
        trySave({ ...config, permissionMode: res.mode });
        append({ kind: "notice", text: `Permission mode: ${res.mode}` });
        break;
      case "runPrompt":
        void runTurn(res.text, { hideInput: true });
        break;
      case "compact":
        void doCompact();
        break;
      case "toggleVim": {
        const next = !vim;
        setVim(next);
        trySave({ ...config, vim: next });
        append({ kind: "notice", text: `Vim mode ${next ? "on" : "off"}.` });
        break;
      }
      case "toggleZdr": {
        const or = config.providers.openrouter ?? {};
        const next = !or.enforceZdr;
        // trySave updates config state too, so the zdrEnforced dep rebuilds the
        // session and the provider.zdr preference rides on the next turn's requests.
        trySave({
          ...config,
          providers: { ...config.providers, openrouter: { ...or, enforceZdr: next } },
        });
        append({
          kind: "notice",
          text: next
            ? "ZDR enforcement on — OpenRouter requests pinned to zero-data-retention endpoints. Models without one will be rejected."
            : "ZDR enforcement off — OpenRouter may route to endpoints that retain prompts.",
        });
        break;
      }
      case "toggleVerbose": {
        const next = !verbose;
        setVerbose(next);
        append({ kind: "notice", text: `Verbose tool output ${next ? "on" : "off"}.` });
        break;
      }
      case "setOutputStyle":
        setOutputStyle(res.name);
        trySave({ ...config, outputStyle: res.name ?? undefined });
        append({ kind: "notice", text: `Output style: ${res.name ?? "default"}.` });
        break;
      case "mcp": {
        const servers = loadMcpServers(cwd);
        const names = Object.keys(servers);
        if (names.length === 0) {
          append({
            kind: "notice",
            text: "No MCP servers. Add a `mcpServers` map to .privateer/mcp.json.",
          });
          break;
        }
        const conn = mcpRef.current;
        const lines = names.map((name) => {
          const cfg = servers[name] as { url?: string; headers?: unknown };
          const st = conn?.status.find((s) => s.server === name);
          const state = !st ? "· connecting…" : st.error ? `✗ ${st.error}` : `✓ ${st.tools} tool(s)`;
          let auth = "";
          if (typeof cfg.url === "string") {
            auth = cfg.headers
              ? " · static auth"
              : hasStoredAuth(cfg.url)
                ? " · oauth: authorized"
                : " · oauth: not signed in";
          }
          return `  ${name} — ${state}${auth}`;
        });
        append({
          kind: "notice",
          text: `MCP servers:\n${lines.join("\n")}\n\n/mcp logout [server] clears saved OAuth.`,
        });
        break;
      }
      case "mcpLogout": {
        const servers = loadMcpServers(cwd);
        // Only remote servers that use OAuth (a URL, no static header) have stored creds.
        const oauthServers = Object.entries(servers).filter(
          ([, c]) => typeof (c as { url?: string }).url === "string" && !(c as { headers?: unknown }).headers,
        );
        const targets = res.server ? oauthServers.filter(([n]) => n === res.server) : oauthServers;
        if (res.server && targets.length === 0) {
          append({ kind: "notice", tone: "error", text: `No OAuth MCP server "${res.server}".` });
          break;
        }
        for (const [, c] of targets) clearStoredAuth((c as { url: string }).url);
        append({
          kind: "notice",
          text: targets.length
            ? `Cleared saved OAuth for ${targets.length} server(s). Reconnect to re-authorize.`
            : "No OAuth credentials to clear.",
        });
        break;
      }
      case "rewind":
        if (checkpointsRef.current.list().length === 0) {
          append({ kind: "notice", text: "No checkpoints yet — they're taken before each turn." });
        } else {
          setRewinding(true);
        }
        break;
      case "sessions": {
        // Exclude the in-progress session so the picker only offers prior ones.
        const list = listSessions(cwd).filter((s) => s.id !== sessionIdRef.current);
        if (list.length === 0) {
          append({ kind: "notice", text: "No other saved sessions for this project yet." });
        } else {
          setSessions(list);
          setSessionsPicking(true);
        }
        break;
      }
      case "export": {
        const dest = res.path ?? join(cwd, `privateer-transcript-${Date.now()}.md`);
        try {
          writeFileSync(dest, serializeTranscript(committed), "utf8");
          append({ kind: "notice", text: `Exported ${committed.length} entries to ${dest}` });
        } catch (err) {
          append({ kind: "notice", tone: "error", text: `Export failed: ${String(err)}` });
        }
        break;
      }
      case "onboarding":
        onLogin?.();
        break;
      case "notice":
        append({ kind: "notice", text: res.text, tone: res.tone });
        break;
    }
    return true;
  }

  async function doCompact() {
    const engine = engineRef.current;
    if (!engine || busy) return;
    setBusy(true);
    try {
      const res = await engine.compact();
      append(
        res
          ? { kind: "notice", text: `Compacted context (~${res.before} → ~${res.after} tokens).` }
          : { kind: "notice", text: "Nothing to compact yet." },
      );
      persist();
    } catch (err) {
      append({ kind: "notice", tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function applyModel(spec: string) {
    setModelSpec(spec);
    trySave({ ...config, defaultModel: spec });
    append({ kind: "notice", text: `Model set to ${spec}` });
  }

  function trySave(next: Config) {
    // Keep the in-memory config the single source of truth so independent toggles
    // (mode, vim, model, zdr) compose instead of clobbering each other on disk.
    setConfig(next);
    try {
      saveGlobalConfig(next);
    } catch {
      /* non-fatal: settings just won't persist */
    }
  }

  async function runTurn(text: string, opts?: { hideInput?: boolean; skipPlanConfirm?: boolean }) {
    // Claim any attachments the input already resolved live (drag-drop/paste): their
    // chips are in `text`, so pull their base64 out of the pending list. Filtering by
    // surviving chip drops ones the user edited away and is queue-safe (each turn
    // takes only its own).
    const liveAttachments = pendingImagesRef.current.filter((a) => text.includes(chipFor(a)));
    pendingImagesRef.current = pendingImagesRef.current.filter((a) => !liveAttachments.includes(a));
    // Rewrite any *still-raw* file paths (typed, or @-mentioned from the file menu) to
    // short "[Kind #n]" chips, and inline referenced text/code files, before the prompt
    // is checkpointed, shown, or sent. Binary attachments ride alongside the chip text
    // into the model message; inlined text is appended to what the model receives.
    const resolved = resolveAttachments(text, cwd, imageSeqRef.current, config.router?.inlineTextMaxBytes);
    imageSeqRef.current += resolved.attachments.length;
    text = resolved.text;
    const attachments = [...liveAttachments, ...resolved.attachments];
    // Persist each attachment's bytes to the session store so the save_attachment tool
    // can write it to disk later, by its "#n", without touching the volatile drop path.
    for (const a of attachments) attachmentsRef.current.register(a);
    const inlinedText = resolved.inlinedText;

    // Checkpoint the state before this turn so /rewind can return here.
    const eng0 = engineRef.current;
    if (eng0) {
      checkpointsRef.current.create({
        messagesLength: eng0.messages.length,
        committedLength: committedRef.current.length,
        label: text,
      });
    }
    if (!opts?.hideInput) append({ kind: "user", text });
    const engine = engineRef.current;
    if (!engine) {
      append({
        kind: "notice",
        tone: "error",
        text: sessionError ?? "No model configured. Use /model or /provider.",
      });
      return;
    }

    setVerb(randomVerb());
    setBusy(true);
    setTurnUsage(emptyUsage());
    const turnStart = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    let liveEntries: Entry[] = [];
    let assistantIdx = -1;
    let thinkingIdx = -1;
    // Coalesce streaming re-renders. Pushing every token delta to state repaints
    // the entire dynamic region per token, which thrashes the CPU and makes any
    // in-progress text selection flicker. Throttle to a trailing flush (~30fps);
    // the finally block clears the timer and does the final commit, so nothing is
    // lost. setLive reads the current `liveEntries` at flush time.
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (syncTimer) return;
      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        setLive(liveEntries);
      }, 33);
    };
    const pushLive = (e: Entry) => {
      liveEntries = [...liveEntries, e];
      sync();
    };

    // The transcript shows `text` (chips + [file: …]); the model also receives the
    // inlined contents of any read-as-text files.
    let sendText = inlinedText ? `${text}\n\n${inlinedText}` : text;
    try {
      // UserPromptSubmit hooks may veto the turn or inject extra context.
      if (hooks.has("UserPromptSubmit")) {
        const outcome = await hooks.prompt(text);
        if (outcome.block) {
          pushLive({
            kind: "notice",
            tone: "error",
            text: `Prompt blocked by hook${outcome.reason ? `: ${outcome.reason}` : ""}.`,
          });
          return;
        }
        if (outcome.additionalContext) {
          sendText = `${sendText}\n\n[Hook context]\n${outcome.additionalContext}`;
        }
      }
      for await (const ev of engine.send(sendText, controller.signal, attachments)) {
        switch (ev.type) {
          case "text":
            thinkingIdx = -1;
            if (assistantIdx === -1) {
              pushLive({ kind: "assistant", text: ev.text });
              assistantIdx = liveEntries.length - 1;
            } else {
              const idx = assistantIdx;
              liveEntries = liveEntries.map((e, i) =>
                i === idx && e.kind === "assistant" ? { ...e, text: e.text + ev.text } : e,
              );
              sync();
            }
            break;
          case "reasoning":
            if (thinkingIdx === -1) {
              pushLive({ kind: "thinking", text: ev.text });
              thinkingIdx = liveEntries.length - 1;
            } else {
              const idx = thinkingIdx;
              liveEntries = liveEntries.map((e, i) =>
                i === idx && e.kind === "thinking" ? { ...e, text: e.text + ev.text } : e,
              );
              sync();
            }
            break;
          case "tool-call": {
            // `task` calls carry the sub-agent's description/type so the grouped
            // agents view can label each row before its metrics land.
            const o = (ev.input ?? {}) as Record<string, unknown>;
            const agent =
              ev.name === "task"
                ? {
                    description: String(o.description ?? ""),
                    subagentType: o.subagent_type ? String(o.subagent_type) : undefined,
                  }
                : undefined;
            pushLive({ kind: "tool", id: ev.id, name: ev.name, input: ev.input, status: "running", agent });
            assistantIdx = -1;
            thinkingIdx = -1;
            break;
          }
          case "tool-result": {
            const m = subAgentMetricsRef.current.get(ev.id);
            liveEntries = liveEntries.map((e) =>
              e.kind === "tool" && e.id === ev.id
                ? { ...e, status: "done", output: asText(ev.output), agent: mergeAgentMetrics(e.agent, m) }
                : e,
            );
            sync();
            break;
          }
          case "tool-error": {
            const m = subAgentMetricsRef.current.get(ev.id);
            liveEntries = liveEntries.map((e) =>
              e.kind === "tool" && e.id === ev.id
                ? { ...e, status: "error", error: ev.error, agent: mergeAgentMetrics(e.agent, m) }
                : e,
            );
            sync();
            break;
          }
          case "usage":
            // Live running total — ticks the token count up between steps.
            setUsage(ev.usage);
            setTurnUsage(ev.turn);
            setContext(engine.contextUsage());
            break;
          case "finish":
            setUsage(engine.usage);
            // ev.usage is this turn's authoritative total (see QueryEngine finish).
            setLastTurnUsage(ev.usage);
            setContext(engine.contextUsage());
            break;
          case "aborted":
            pushLive({ kind: "notice", text: "Interrupted." });
            break;
          case "compacted":
            pushLive({ kind: "notice", text: `Auto-compacted context (~${ev.before} → ~${ev.after} tokens).` });
            break;
          case "routed":
            pushLive(
              ev.missing && ev.missing.length > 0
                ? {
                    kind: "notice",
                    tone: "error",
                    text: `No model configured for ${ev.missing.join("/")} input — ${ev.label} may not process it. Set router.${ev.missing[0] === "image" ? "vision" : ev.missing[0]}.`,
                  }
                : { kind: "notice", text: `↪ routed to ${ev.label}${ev.reason ? ` · ${ev.reason}` : ""}` },
            );
            break;
          case "error":
            pushLive({ kind: "notice", tone: "error", text: ev.error, hint: ev.hint });
            break;
        }
      }
    } catch (err) {
      pushLive({ kind: "notice", tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
      // Cancel any pending throttled flush so it can't re-emit these entries into
      // the live region after we've moved them into the committed transcript.
      clearTimeout(syncTimer);
      // Close out the turn with how long the agent took to process the request to
      // completion — the live spinner's running timer, frozen as a total.
      const took = Date.now() - turnStart;
      const finalEntries: Entry[] = [
        ...liveEntries,
        { kind: "notice", text: `⏱ ${formatDuration(took)} total` },
      ];
      setLive([]);
      setCommitted((c) => [...c, ...finalEntries]);
      setBusy(false);
      persist();
      if (hooks.has("Stop")) void hooks.stop();
      // In plan mode, once the agent has presented a plan, offer to leave plan mode.
      if (
        !opts?.skipPlanConfirm &&
        modeRef.current === "plan" &&
        finalEntries.some((e) => e.kind === "assistant" && e.text.trim().length > 0)
      ) {
        setPlanReady(true);
      }
    }
  }

  function approvePlan() {
    setPlanReady(false);
    setMode("default");
    trySave({ ...config, permissionMode: "default" });
    append({ kind: "notice", text: "Plan approved — exited plan mode. Tell me to proceed." });
  }

  function restoreCheckpoint(id: string, scope: RewindScope) {
    setRewinding(false);
    const store = checkpointsRef.current;
    const cp = store.get(id);
    if (!cp) return;
    if (scope === "files" || scope === "both") store.restoreFiles(cp);
    if (scope === "conversation" || scope === "both") {
      const eng = engineRef.current;
      if (eng && eng.messages.length > cp.messagesLength) eng.messages.length = cp.messagesLength;
      setCommitted(committedRef.current.slice(0, cp.committedLength));
      setLive([]);
    }
    persist();
    append({ kind: "notice", text: `Rewound to "${cp.label}" (${scope}).` });
  }

  // Swap the live conversation for a stored one. Like startup --continue, this reseeds
  // the engine's context (and adopts that session's id so further turns persist back to
  // it) rather than replaying the old transcript as visible history.
  function resumeSession(id: string) {
    setSessionsPicking(false);
    const data = loadSession(cwd, id);
    const eng = engineRef.current;
    if (!data || !eng) {
      append({ kind: "notice", tone: "error", text: "Could not load that session." });
      return;
    }
    eng.messages.length = 0;
    eng.messages.push(...data.messages);
    eng.usage = data.usage;
    setUsage(data.usage);
    setCommitted([]);
    setLive([]);
    todosRef.current?.set([]);
    sessionIdRef.current = data.id;
    // Adopt the resumed session's checkpoints so /rewind acts on its history, not the
    // one we just left. Mutated in place so the engine's recordMutation closure stays
    // valid (the session isn't rebuilt on resume).
    checkpointsRef.current.adopt(checkpointsDir(cwd, data.id));
    persist();
    append({ kind: "notice", text: `Resumed session (${data.messages.length} messages).` });
  }

  // Entry point from the prompt input. While a turn is running, messages are
  // queued and drained in order when it finishes.
  function handleInput(value: string) {
    const text = value.trim();
    if (!text) return;
    if (busy || drainingRef.current) {
      queueRef.current.push(value);
      setQueued(queueRef.current.length);
      append({ kind: "notice", text: `Queued (${queueRef.current.length}) — runs after the current turn.` });
      return;
    }
    void dispatchInput(value);
  }

  async function dispatchInput(value: string) {
    const text = value.trim();
    if (isSlashCommand(text)) {
      handleCommand(text);
      return;
    }
    if (text.startsWith("!")) {
      await runBash(text.slice(1).trim());
      return;
    }
    if (text.startsWith("#")) {
      addMemory(text.slice(1).trim());
      return;
    }
    await runTurn(text);
  }

  // Drain queued messages once the UI is idle. Runs them sequentially so turns
  // never overlap.
  async function drainQueue() {
    if (drainingRef.current || busy) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        setQueued(queueRef.current.length);
        await dispatchInput(next);
      }
    } finally {
      drainingRef.current = false;
    }
  }

  useEffect(() => {
    if (!busy) void drainQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // `!cmd` — run a shell command locally and show its output, without a model turn.
  async function runBash(cmd: string) {
    if (!cmd) return;
    append({ kind: "user", text: `!${cmd}` });
    setBusy(true);
    try {
      const res = await exec(cmd, [], { cwd, timeoutMs: 120_000, shell: true });
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      append({
        kind: "tool",
        id: `bash-${Date.now()}`,
        name: "bash",
        input: { command: cmd },
        status: res.code === 0 ? "done" : "error",
        output: out || "(no output)",
        error: res.code === 0 ? undefined : res.timedOut ? "timed out" : `exit ${res.code}`,
      });
    } catch (err) {
      append({ kind: "notice", tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  // `#note` — append a bullet to the project's PRIVATEER.md memory file.
  function addMemory(note: string) {
    if (!note) return;
    const path = join(cwd, "PRIVATEER.md");
    try {
      const head = existsSync(path)
        ? readFileSync(path, "utf8").replace(/\s*$/, "") + "\n"
        : "# Project context\n";
      writeFileSync(path, `${head}\n- ${note}\n`, "utf8");
      append({ kind: "notice", text: `Added to memory (PRIVATEER.md): ${note}` });
    } catch (err) {
      append({ kind: "notice", tone: "error", text: `Could not write PRIVATEER.md: ${String(err)}` });
    }
  }

  // Group concurrent `task` sub-agents into single rows before committing to <Static>
  // (and again for the live region below) so the fan-out renders as one block.
  const staticItems: (typeof BANNER | Row)[] = [BANNER, ...groupRows(committed)];

  return (
    <Box flexDirection="column">
      <Static key={resizeNonce} items={staticItems}>
        {(item, i) =>
          item === BANNER ? (
            <Box key="banner" paddingX={1} paddingTop={1}>
              <Banner model={modelSpec} />
            </Box>
          ) : (
            <Box key={i} paddingX={1}>
              <RowView row={item as Row} verbose={verbose} collapsed={collapsed} />
            </Box>
          )
        }
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {groupRows(live).map((row, i) => (
          <RowView key={i} row={row} verbose={verbose} collapsed={collapsed} />
        ))}

        {/* While a prompt is pending the turn is blocked on the human, so there's
            no work to animate. Crucially, ink-spinner re-renders the whole dynamic
            region every frame; left running it would erase+redraw the bordered
            ApprovalPrompt below it ~10×/s, which reads as the box flickering. */}
        {busy && !pending && (
          <Box marginTop={1} gap={1}>
            <Text color={theme.accent}>
              <Spinner type="dots" />
            </Text>
            <Text color={theme.accent} wrap="truncate-end">
              {verb}…
            </Text>
            <Text color={theme.dim} wrap="truncate-end">
              (esc to interrupt · {elapsed}s · {DOWN} {formatTokens(turnUsage.outputTokens)} tokens)
            </Text>
          </Box>
        )}

        <TodoPanel todos={todos} />

        <StatusBar
          modelSpec={modelSpec}
          cwd={cwd}
          usage={usage}
          context={context}
          lastTurn={lastTurnUsage}
          custom={statusText || undefined}
          zdr={zdr}
        />

        {picking ? (
          <ModelPicker
            config={config}
            onSelect={(spec) => {
              setPicking(false);
              applyModel(spec);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : pending ? (
          <ApprovalPrompt
            req={pending.req}
            onRespond={(outcome) => {
              pending.resolve(outcome);
              setPending(null);
            }}
          />
        ) : rewinding ? (
          <RewindPicker
            checkpoints={checkpointsRef.current.list()}
            onRestore={restoreCheckpoint}
            onCancel={() => setRewinding(false)}
          />
        ) : sessionsPicking ? (
          <SessionPicker
            sessions={sessions}
            onResume={resumeSession}
            onCancel={() => setSessionsPicking(false)}
          />
        ) : planReady ? (
          <PlanConfirm onApprove={approvePlan} onKeep={() => setPlanReady(false)} />
        ) : (
          <>
            <PromptInput
              busy={busy}
              cwd={cwd}
              queued={queued}
              vimEnabled={vim}
              commands={commands}
              history={historyRef}
              imageSeqRef={imageSeqRef}
              pendingImagesRef={pendingImagesRef}
              onSubmit={handleInput}
              onClear={() => {
                setCommitted([]);
                setLive([]);
              }}
            />
            <ModeHint mode={mode} collapsed={collapsed} />
          </>
        )}
      </Box>
    </Box>
  );
}

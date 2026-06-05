import React, { useState, useRef, useEffect, useMemo } from "react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, Static, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { Banner } from "./Banner.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { EntryView } from "./Transcript.tsx";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { PlanConfirm } from "./PlanConfirm.tsx";
import { RewindPicker } from "./RewindPicker.tsx";
import { CheckpointStore, type RewindScope } from "../memory/checkpoints.ts";
import { ProcessRegistry } from "../tools/processRegistry.ts";
import { HookRunner, loadHooks } from "../hooks/engine.ts";
import type { ToolSet } from "ai";
import { loadMcpServers, connectMcpServers, type McpStdioClient, type McpConnection } from "../mcp/client.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { exec } from "../tools/exec.ts";
import { extractImages } from "../util/images.ts";
import type { Entry } from "./types.ts";
import type { TodoStore, TodoItem } from "../tools/todoStore.ts";
import type { Config, PermissionMode } from "../config/schema.ts";
import { createSession } from "../session.ts";
import { QueryEngine } from "../engine/QueryEngine.ts";
import { emptyUsage, type UsageTotals } from "../engine/events.ts";
import { runCommand, commandList } from "../commands/registry.ts";
import { loadCustomCommands } from "../commands/custom.ts";
import { saveGlobalConfig } from "../config/load.ts";
import { ModeGate, type AskOutcome } from "../permissions/uiGate.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import { saveSession, type SessionData } from "../memory/store.ts";
import { theme } from "./theme.ts";
import { randomVerb } from "./spinnerVerbs.ts";

interface PendingApproval {
  req: PermissionRequest;
  resolve: (outcome: AskOutcome) => void;
}

const BANNER = "__banner__";

function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
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
  config,
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
  const { exit } = useApp();
  const [committed, setCommitted] = useState<Entry[]>([]);
  const [live, setLive] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelSpec, setModelSpec] = useState(model);
  const [mode, setMode] = useState<PermissionMode>(config.permissionMode);
  const [usage, setUsage] = useState<UsageTotals>(resume?.usage ?? emptyUsage());
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
  const [mcpTools, setMcpTools] = useState<ToolSet>({});
  const mcpRef = useRef<McpConnection | null>(null);
  const [statusText, setStatusText] = useState("");
  const [verbose, setVerbose] = useState(false);
  const engineRef = useRef<QueryEngine | null>(null);
  const todosRef = useRef<TodoStore | null>(null);
  const seededRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Input history (↑/↓) and the type-ahead queue for messages entered while busy.
  const historyRef = useRef<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  // Session-lifetime checkpoint store (survives model/style switches) for /rewind,
  // plus a live mirror of the committed transcript length for checkpointing.
  const checkpointsRef = useRef<CheckpointStore>(new CheckpointStore());
  const committedRef = useRef<Entry[]>([]);
  // Background-shell registry, shared across the session for bash run_in_background.
  const processesRef = useRef<ProcessRegistry>(new ProcessRegistry());

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
  }, [modelSpec, outputStyle, mode === "plan", mcpTools]);

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
    void connectMcpServers(servers, cwd, gate).then((conn) => {
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
      saveSession(cwd, { modelSpec, messages: eng.messages, usage: eng.usage });
    } catch {
      /* non-fatal */
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    // Esc interrupts an in-flight turn (the run loop persists partial output).
    if (key.escape && busy && abortRef.current) abortRef.current.abort();
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
    const res = runCommand(raw, { config, modelSpec, mode, usage, cwd, todos, customCommands });
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
        const conn = mcpRef.current;
        if (!conn || conn.status.length === 0) {
          append({
            kind: "notice",
            text: "No MCP servers. Add a `mcpServers` map to .privateer/mcp.json.",
          });
        } else {
          const lines = conn.status.map((s) =>
            s.error ? `  ✗ ${s.server} — ${s.error}` : `  ✓ ${s.server} — ${s.tools} tool(s)`,
          );
          append({ kind: "notice", text: `MCP servers:\n${lines.join("\n")}` });
        }
        break;
      }
      case "rewind":
        if (checkpointsRef.current.list().length === 0) {
          append({ kind: "notice", text: "No checkpoints yet — they're taken before each turn." });
        } else {
          setRewinding(true);
        }
        break;
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
    try {
      saveGlobalConfig(next);
    } catch {
      /* non-fatal: settings just won't persist */
    }
  }

  async function runTurn(text: string, opts?: { hideInput?: boolean; skipPlanConfirm?: boolean }) {
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
    const controller = new AbortController();
    abortRef.current = controller;
    let liveEntries: Entry[] = [];
    let assistantIdx = -1;
    let thinkingIdx = -1;
    const sync = () => setLive(liveEntries);
    const pushLive = (e: Entry) => {
      liveEntries = [...liveEntries, e];
      sync();
    };

    let sendText = text;
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
          sendText = `${text}\n\n[Hook context]\n${outcome.additionalContext}`;
        }
      }
      // Attach any image files referenced in the prompt (vision-capable models only).
      const images = extractImages(text, cwd);
      if (images.length > 0) {
        pushLive({ kind: "notice", text: `Attached ${images.length} image(s).` });
      }
      for await (const ev of engine.send(sendText, controller.signal, images)) {
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
          case "tool-call":
            pushLive({ kind: "tool", id: ev.id, name: ev.name, input: ev.input, status: "running" });
            assistantIdx = -1;
            thinkingIdx = -1;
            break;
          case "tool-result":
            liveEntries = liveEntries.map((e) =>
              e.kind === "tool" && e.id === ev.id ? { ...e, status: "done", output: asText(ev.output) } : e,
            );
            sync();
            break;
          case "tool-error":
            liveEntries = liveEntries.map((e) =>
              e.kind === "tool" && e.id === ev.id ? { ...e, status: "error", error: ev.error } : e,
            );
            sync();
            break;
          case "finish":
            setUsage(engine.usage);
            break;
          case "aborted":
            pushLive({ kind: "notice", text: "Interrupted." });
            break;
          case "compacted":
            pushLive({ kind: "notice", text: `Auto-compacted context (~${ev.before} → ~${ev.after} tokens).` });
            break;
          case "error":
            pushLive({ kind: "notice", tone: "error", text: ev.error });
            break;
        }
      }
    } catch (err) {
      pushLive({ kind: "notice", tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
      const finalEntries = liveEntries;
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
    if (text.startsWith("/")) {
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

  const staticItems: (typeof BANNER | Entry)[] = [BANNER, ...committed];

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item, i) =>
          item === BANNER ? (
            <Box key="banner" paddingX={1} paddingTop={1}>
              <Banner model={modelSpec} />
            </Box>
          ) : (
            <Box key={i} paddingX={1}>
              <EntryView entry={item as Entry} verbose={verbose} />
            </Box>
          )
        }
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {live.map((e, i) => (
          <EntryView key={i} entry={e} verbose={verbose} />
        ))}

        {busy && (
          <Box marginTop={1} gap={1}>
            <Text color={theme.accent}>
              <Spinner type="dots" />
            </Text>
            <Text color={theme.accent}>{verb}…</Text>
            <Text color={theme.dim}>
              (esc to interrupt · {elapsed}s · {usage.totalTokens} tokens)
            </Text>
          </Box>
        )}

        <TodoPanel todos={todos} />

        <StatusBar
          modelSpec={modelSpec}
          cwd={cwd}
          totalTokens={usage.totalTokens}
          mode={mode}
          custom={statusText || undefined}
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
        ) : planReady ? (
          <PlanConfirm onApprove={approvePlan} onKeep={() => setPlanReady(false)} />
        ) : (
          <PromptInput
            busy={busy}
            cwd={cwd}
            queued={queued}
            vimEnabled={vim}
            commands={commands}
            history={historyRef}
            onSubmit={handleInput}
            onClear={() => {
              setCommitted([]);
              setLive([]);
            }}
          />
        )}
      </Box>
    </Box>
  );
}

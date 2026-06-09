import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.ts";
import { POINTER, TREE } from "./figures.ts";
import { walkFiles } from "../tools/walk.ts";
import { detectMode, slashQuery, mentionAt, filterCommands, filterFiles } from "./promptModel.ts";
import { resolveAttachments, chipFor, describeAttachment } from "../util/images.ts";
import type { Attachment } from "../util/images.ts";

const MENU_LIMIT = 8;

interface Candidate {
  value: string; // text used when accepting
  label: string; // primary display
  hint?: string; // secondary, dimmed
}

const MODE_TAG: Record<string, { label: string; color: string } | undefined> = {
  bash: { label: "bash", color: theme.warning },
  memory: { label: "memory", color: theme.success },
  command: { label: "command", color: theme.accent },
};

export function PromptInput({
  busy,
  cwd,
  queued,
  vimEnabled = false,
  commands,
  history,
  imageSeqRef,
  pendingImagesRef,
  onSubmit,
  onClear,
}: {
  busy: boolean;
  cwd: string;
  queued: number;
  vimEnabled?: boolean;
  commands: { name: string; summary: string }[];
  history: React.MutableRefObject<string[]>;
  // Shared session counter for "[Image #n]" chips and the staging area where
  // live-resolved (drag-drop/paste) attachments wait to be claimed at submit.
  // Both optional so the component can render without image support (tests).
  imageSeqRef?: React.MutableRefObject<number>;
  pendingImagesRef?: React.MutableRefObject<Attachment[]>;
  onSubmit: (value: string) => void;
  onClear?: () => void;
}) {
  // value + cursor live in one state object so edits compose via functional
  // updates — robust to batched keystroke bursts (and to test harness input).
  const [{ value, cursor }, setBufState] = useState<{ value: string; cursor: number }>({
    value: "",
    cursor: 0,
  });
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  // Vim modal editing: "insert" is the normal text-entry mode; "normal" is the
  // motion/command mode. Only consulted when vimEnabled.
  const [vimMode, setVimMode] = useState<"insert" | "normal">("insert");
  const pendingOpRef = useRef<string | null>(null); // for two-key ops like `dd`
  // ctrl-r reverse history search: query + index among matches, or null when off.
  const [search, setSearch] = useState<{ query: string; index: number } | null>(null);
  // Always-current mirror of the buffer. The useInput closure can lag a render
  // behind in Ink, so logic that must read the live value (submit) reads this.
  // Assigned during render (not in an effect) so it's current the moment the
  // matching frame is committed.
  const bufRef = useRef({ value, cursor });
  bufRef.current = { value, cursor };
  // Same render-synced mirror for the modal flags the input handler reads.
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const searchRef = useRef(search);
  searchRef.current = search;
  // Most recently killed text (Ctrl+K/U/W, Alt+D); re-inserted by Ctrl+Y.
  const killRef = useRef<string>("");
  // File list is walked lazily on first @-mention so we don't pay for it at mount.
  const filesRef = useRef<string[] | null>(null);
  const getFiles = () => (filesRef.current ??= walkFiles(cwd));

  const mode = detectMode(value);
  const sQuery = slashQuery(value, cursor);
  const mention = mentionAt(value, cursor);

  const { candidates, menuKind } = useMemo((): {
    candidates: Candidate[];
    menuKind: "command" | "file" | null;
  } => {
    if (dismissed) return { candidates: [], menuKind: null };
    if (sQuery !== null) {
      const items: Candidate[] = filterCommands(commands, sQuery).map((c) => ({
        value: c.name,
        label: `/${c.name}`,
        hint: c.summary,
      }));
      return { candidates: items, menuKind: "command" };
    }
    if (mention) {
      const items: Candidate[] = filterFiles(getFiles(), mention.query, MENU_LIMIT).map((f) => ({
        value: f,
        label: f,
      }));
      return { candidates: items, menuKind: "file" };
    }
    return { candidates: [], menuKind: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, cursor, dismissed, commands]);

  const menuOpen = menuKind !== null && candidates.length > 0;
  const selClamped = Math.min(sel, Math.max(0, candidates.length - 1));

  // --- cursor / buffer helpers ---
  type Buf = { value: string; cursor: number };
  const clamp = (v: string, c: number) => Math.max(0, Math.min(c, v.length));
  const lineStart = (v: string, c: number) => v.lastIndexOf("\n", c - 1) + 1;
  const lineEnd = (v: string, c: number) => {
    const nl = v.indexOf("\n", c);
    return nl === -1 ? v.length : nl;
  };
  // Word motions (vim w/b): skip the current run then any whitespace.
  function wordForward(v: string, c: number): number {
    let i = c;
    while (i < v.length && !/\s/.test(v[i])) i++;
    while (i < v.length && /\s/.test(v[i])) i++;
    return i;
  }
  function wordBack(v: string, c: number): number {
    let i = c;
    while (i > 0 && /\s/.test(v[i - 1])) i--;
    while (i > 0 && !/\s/.test(v[i - 1])) i--;
    return i;
  }
  // Readline-style forward word (Alt+F / Alt+D): skip leading whitespace then
  // the word, landing at the *end* of the word (unlike vim's `w` above).
  function wordRight(v: string, c: number): number {
    let i = c;
    while (i < v.length && /\s/.test(v[i])) i++;
    while (i < v.length && !/\s/.test(v[i])) i++;
    return i;
  }
  // History entries (newest first, de-duped) containing `query`, for ctrl-r search.
  function searchMatches(query: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = history.current.length - 1; i >= 0; i--) {
      const e = history.current[i];
      if (e.includes(query) && !seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
    return out;
  }

  // Edit the buffer from its previous value (burst-safe) and reset menu/history.
  function edit(fn: (b: Buf) => Buf) {
    setBufState((b) => {
      const n = fn(b);
      return { value: n.value, cursor: clamp(n.value, n.cursor) };
    });
    setHistIdx(null);
    setDismissed(false);
    setSel(0);
  }
  // Move the cursor only, preserving menu/history context.
  function moveCursor(fn: (b: Buf) => number) {
    setBufState((b) => ({ value: b.value, cursor: clamp(b.value, fn(b)) }));
  }
  function replaceBuf(v: string, c: number) {
    setBufState({ value: v, cursor: clamp(v, c) });
  }

  function accept(cand: Candidate) {
    if (menuKind === "command") {
      const next = `/${cand.value} `;
      edit(() => ({ value: next, cursor: next.length }));
    } else if (menuKind === "file" && mention) {
      edit((b) => {
        const before = b.value.slice(0, mention.start);
        const token = `@${cand.value} `;
        return { value: before + token + b.value.slice(b.cursor), cursor: before.length + token.length };
      });
    }
  }

  function submit() {
    const v = bufRef.current.value;
    if (v.trim().length === 0) return;
    history.current.push(v);
    replaceBuf("", 0);
    setHistIdx(null);
    setDismissed(false);
    setSel(0);
    setVimMode("insert");
    onSubmit(v);
  }

  function histStep(dir: -1 | 1) {
    const h = history.current;
    if (h.length === 0) return;
    let idx: number;
    if (dir === -1) idx = histIdx === null ? h.length - 1 : Math.max(0, histIdx - 1);
    else {
      if (histIdx === null) return;
      idx = histIdx + 1;
      if (idx >= h.length) {
        replaceBuf("", 0);
        setHistIdx(null);
        return;
      }
    }
    replaceBuf(h[idx], h[idx].length);
    setHistIdx(idx);
  }

  function moveLine(dir: -1 | 1) {
    setBufState((b) => {
      const ls = lineStart(b.value, b.cursor);
      const col = b.cursor - ls;
      if (dir === -1) {
        if (ls === 0) return b;
        const prevStart = lineStart(b.value, ls - 1);
        return { value: b.value, cursor: prevStart + Math.min(col, ls - 1 - prevStart) };
      }
      const le = lineEnd(b.value, b.cursor);
      if (le === b.value.length) return b;
      const nextStart = le + 1;
      return { value: b.value, cursor: nextStart + Math.min(col, lineEnd(b.value, nextStart) - nextStart) };
    });
  }

  // Current ctrl-r reverse-search results (newest first) and the highlighted match.
  const searchResults = search ? searchMatches(search.query) : [];
  const searchMatch = search
    ? (searchResults[Math.min(search.index, Math.max(0, searchResults.length - 1))] ?? "")
    : "";

  function acceptSearch() {
    replaceBuf(searchMatch, searchMatch.length);
    setSearch(null);
  }

  // Keys while the reverse-search prompt is active.
  function handleSearchKey(str: string, key: { return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; leftArrow?: boolean; rightArrow?: boolean }) {
    if (key.ctrl && str === "r") return void setSearch((s) => (s ? { ...s, index: s.index + 1 } : s));
    if (key.return) return void acceptSearch();
    if (key.leftArrow || key.rightArrow) return void acceptSearch();
    if (key.escape || (key.ctrl && str === "c")) return void setSearch(null);
    if (key.backspace || key.delete) return void setSearch((s) => (s ? { query: s.query.slice(0, -1), index: 0 } : s));
    if (key.ctrl || !str) return;
    setSearch((s) => (s ? { query: s.query + str, index: 0 } : s));
  }

  // Vim normal-mode keys. Returns true when the key was consumed.
  function handleNormalKey(str: string): boolean {
    const enterInsert = () => setVimMode("insert");
    // Two-key operator: dd deletes the current line.
    if (pendingOpRef.current === "d") {
      pendingOpRef.current = null;
      if (str === "d") {
        edit((b) => {
          const ls = lineStart(b.value, b.cursor);
          const le = lineEnd(b.value, b.cursor);
          const start = ls > 0 && le === b.value.length ? ls - 1 : ls;
          const end = b.value[le] === "\n" ? le + 1 : le;
          return { value: b.value.slice(0, start) + b.value.slice(end), cursor: start };
        });
        return true;
      }
    }
    switch (str) {
      case "i":
        enterInsert();
        return true;
      case "a":
        moveCursor((b) => b.cursor + 1);
        enterInsert();
        return true;
      case "I":
        moveCursor((b) => lineStart(b.value, b.cursor));
        enterInsert();
        return true;
      case "A":
        moveCursor((b) => lineEnd(b.value, b.cursor));
        enterInsert();
        return true;
      case "o":
        edit((b) => {
          const le = lineEnd(b.value, b.cursor);
          return { value: b.value.slice(0, le) + "\n" + b.value.slice(le), cursor: le + 1 };
        });
        enterInsert();
        return true;
      case "O":
        edit((b) => {
          const ls = lineStart(b.value, b.cursor);
          return { value: b.value.slice(0, ls) + "\n" + b.value.slice(ls), cursor: ls };
        });
        enterInsert();
        return true;
      case "h":
        moveCursor((b) => b.cursor - 1);
        return true;
      case "l":
        moveCursor((b) => b.cursor + 1);
        return true;
      case "k":
        if (value.includes("\n")) moveLine(-1);
        else histStep(-1);
        return true;
      case "j":
        if (value.includes("\n")) moveLine(1);
        else histStep(1);
        return true;
      case "0":
        moveCursor((b) => lineStart(b.value, b.cursor));
        return true;
      case "$":
        moveCursor((b) => lineEnd(b.value, b.cursor));
        return true;
      case "w":
        moveCursor((b) => wordForward(b.value, b.cursor));
        return true;
      case "b":
        moveCursor((b) => wordBack(b.value, b.cursor));
        return true;
      case "x":
        edit((b) => ({ value: b.value.slice(0, b.cursor) + b.value.slice(b.cursor + 1), cursor: b.cursor }));
        return true;
      case "D":
        edit((b) => ({ value: b.value.slice(0, b.cursor) + b.value.slice(lineEnd(b.value, b.cursor)), cursor: b.cursor }));
        return true;
      case "C":
        edit((b) => ({ value: b.value.slice(0, b.cursor) + b.value.slice(lineEnd(b.value, b.cursor)), cursor: b.cursor }));
        enterInsert();
        return true;
      case "d":
        pendingOpRef.current = "d";
        return true;
      default:
        return true; // swallow other keys in normal mode
    }
  }

  useInput((str, key) => {
    // Reverse-search intercepts everything while active.
    if (searchRef.current) return void handleSearchKey(str, key);
    if (key.ctrl && str === "r") return void setSearch({ query: "", index: 0 });

    // Menu navigation takes priority over history / line moves.
    if (menuOpen && (key.upArrow || key.downArrow)) {
      const n = candidates.length;
      setSel((s) => (key.upArrow ? (Math.min(s, n - 1) - 1 + n) % n : (Math.min(s, n - 1) + 1) % n));
      return;
    }
    // Plain Tab accepts the menu selection; Shift+Tab is reserved for the
    // app-level permission-mode cycle, so let it fall through.
    if (key.tab && !key.shift && menuOpen) {
      accept(candidates[selClamped]);
      return;
    }
    if (key.return) {
      // Backslash-Enter inserts a newline instead of submitting (line continuation).
      const b0 = bufRef.current;
      if (b0.cursor > 0 && b0.value[b0.cursor - 1] === "\\") {
        edit((b) => ({
          value: b.value.slice(0, b.cursor - 1) + "\n" + b.value.slice(b.cursor),
          cursor: b.cursor,
        }));
        return;
      }
      if (menuOpen) {
        accept(candidates[selClamped]);
        return;
      }
      submit();
      return;
    }
    if (key.escape) {
      if (menuOpen) setDismissed(true);
      else if (vimEnabled && vimModeRef.current === "insert") setVimMode("normal");
      return;
    }
    // Arrows work in both vim modes.
    // Ctrl/Alt+arrow jumps by word (must precede the plain one-char moves).
    if (key.leftArrow && (key.ctrl || key.meta)) return void moveCursor((b) => wordBack(b.value, b.cursor));
    if (key.rightArrow && (key.ctrl || key.meta)) return void moveCursor((b) => wordRight(b.value, b.cursor));
    if (key.leftArrow) return void moveCursor((b) => b.cursor - 1);
    if (key.rightArrow) return void moveCursor((b) => b.cursor + 1);
    if (key.upArrow) {
      if (value.includes("\n")) moveLine(-1);
      else histStep(-1);
      return;
    }
    if (key.downArrow) {
      if (value.includes("\n")) moveLine(1);
      else histStep(1);
      return;
    }
    // Vim normal mode consumes letters as motions/commands.
    if (vimEnabled && vimModeRef.current === "normal" && !key.ctrl && !key.meta && str) {
      if (handleNormalKey(str)) return;
    }
    // Alt/Option+Backspace deletes the word before the cursor (readline
    // backward-kill-word; macOS Option+Delete sends ESC + DEL, i.e. meta+backspace).
    // Must precede the plain backspace handler below, which checks neither modifier
    // and would otherwise swallow it as a single-char delete. Saves to killRef so
    // Ctrl+Y can yank it back, matching Ctrl+W.
    if ((key.meta || key.ctrl) && (key.backspace || key.delete))
      return void edit((b) => {
        let i = b.cursor;
        while (i > 0 && /\s/.test(b.value[i - 1])) i--;
        while (i > 0 && !/\s/.test(b.value[i - 1])) i--;
        killRef.current = b.value.slice(i, b.cursor);
        return { value: b.value.slice(0, i) + b.value.slice(b.cursor), cursor: i };
      });
    if (key.backspace || key.delete) {
      edit((b) =>
        b.cursor === 0
          ? b
          : { value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), cursor: b.cursor - 1 },
      );
      return;
    }
    // Emacs/readline-style line editing.
    if (key.ctrl && str === "a") return void moveCursor((b) => lineStart(b.value, b.cursor));
    if (key.ctrl && str === "e") return void moveCursor((b) => lineEnd(b.value, b.cursor));
    if (key.ctrl && str === "b") return void moveCursor((b) => b.cursor - 1);
    if (key.ctrl && str === "f") return void moveCursor((b) => b.cursor + 1);
    if (key.meta && !key.escape && str === "b") return void moveCursor((b) => wordBack(b.value, b.cursor));
    if (key.meta && !key.escape && str === "f") return void moveCursor((b) => wordRight(b.value, b.cursor));
    if (key.ctrl && str === "u")
      return void edit((b) => {
        const ls = lineStart(b.value, b.cursor);
        killRef.current = b.value.slice(ls, b.cursor);
        return { value: b.value.slice(0, ls) + b.value.slice(b.cursor), cursor: ls };
      });
    if (key.ctrl && str === "k")
      return void edit((b) => {
        const le = lineEnd(b.value, b.cursor);
        killRef.current = b.value.slice(b.cursor, le);
        return { value: b.value.slice(0, b.cursor) + b.value.slice(le), cursor: b.cursor };
      });
    if (key.ctrl && str === "w")
      return void edit((b) => {
        let i = b.cursor;
        while (i > 0 && /\s/.test(b.value[i - 1])) i--;
        while (i > 0 && !/\s/.test(b.value[i - 1])) i--;
        killRef.current = b.value.slice(i, b.cursor);
        return { value: b.value.slice(0, i) + b.value.slice(b.cursor), cursor: i };
      });
    if (key.meta && !key.escape && str === "d")
      return void edit((b) => {
        const j = wordRight(b.value, b.cursor);
        killRef.current = b.value.slice(b.cursor, j);
        return { value: b.value.slice(0, b.cursor) + b.value.slice(j), cursor: b.cursor };
      });
    if (key.ctrl && str === "d")
      return void edit((b) =>
        b.cursor >= b.value.length
          ? b
          : { value: b.value.slice(0, b.cursor) + b.value.slice(b.cursor + 1), cursor: b.cursor },
      );
    if (key.ctrl && str === "y")
      return void edit((b) => ({
        value: b.value.slice(0, b.cursor) + killRef.current + b.value.slice(b.cursor),
        cursor: b.cursor + killRef.current.length,
      }));
    if (key.ctrl && str === "l") return void onClear?.();
    if (key.ctrl || key.meta) return; // ignore other control combos (ctrl-c handled in App)
    if (str) {
      // A multi-char chunk is a paste or drag-drop (a terminal sends a dropped
      // file as one escaped path). If it carries attachable file paths, convert them
      // to "[Kind #n]" chips live — so the user sees a short reference instead of a
      // long escaped path — and stage the base64 for the next submit. Single
      // keystrokes are never paths, so they skip this and insert verbatim. (Inlined
      // text files are resolved at submit, not here, so the buffer stays clean.)
      // inlineMaxBytes 0 → text files aren't inlined here; their raw paths stay in the
      // buffer and get inlined at submit (runTurn). Only binary attachments chip live.
      if (str.length > 1 && imageSeqRef && pendingImagesRef) {
        const resolved = resolveAttachments(str, cwd, imageSeqRef.current, 0);
        if (resolved.attachments.length > 0) {
          imageSeqRef.current += resolved.attachments.length;
          pendingImagesRef.current.push(...resolved.attachments);
          const chunk = resolved.text;
          edit((b) => ({
            value: b.value.slice(0, b.cursor) + chunk + b.value.slice(b.cursor),
            cursor: b.cursor + chunk.length,
          }));
          return;
        }
      }
      edit((b) => ({
        value: b.value.slice(0, b.cursor) + str + b.value.slice(b.cursor),
        cursor: b.cursor + str.length,
      }));
    }
  });

  const tag = MODE_TAG[mode];
  const placeholder = busy
    ? queued > 0
      ? `working… (${queued} queued)`
      : "working… (type to queue)"
    : "type a prompt — / commands · @ files · ! bash · # memory";

  const vimTag = vimEnabled ? (vimMode === "normal" ? "NORMAL" : "INSERT") : null;

  // Live provenance for staged drag-drop/paste attachments still referenced in the
  // buffer: filename · dimensions · size. Surfaces a wrong-but-complete capture (the
  // macOS file-promise hazard) before submit — chips alone hide what actually landed.
  // Derived from the buffer text so an edited-away chip drops its line automatically.
  const stagedInBuffer = pendingImagesRef
    ? pendingImagesRef.current.filter((a) => value.includes(chipFor(a)))
    : [];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={busy ? theme.dim : theme.accent} paddingX={1}>
        <Text color={busy ? theme.dim : theme.accent}>{`${POINTER} `}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {search ? (
            <Text>
              <Text color={theme.dim}>{`(reverse-i-search)\`${search.query}\`: `}</Text>
              {searchMatch || <Text color={theme.dim}>(no match)</Text>}
            </Text>
          ) : (
            renderBuffer(value, cursor, placeholder)
          )}
        </Box>
        {vimTag && (
          <Text color={vimMode === "normal" ? theme.warning : theme.dim}> {vimTag}</Text>
        )}
        {tag && (
          <Text color={tag.color}> [{tag.label}]</Text>
        )}
      </Box>

      {stagedInBuffer.length > 0 && (
        <Box flexDirection="column" marginLeft={1}>
          {stagedInBuffer.map((a) => (
            <Text key={a.n} color={theme.dim} wrap="truncate-end">
              {`${TREE} ${chipFor(a)} ${describeAttachment(a)}`}
            </Text>
          ))}
        </Box>
      )}

      {menuOpen && !search && (
        <Box flexDirection="column" paddingX={1} marginLeft={1}>
          {candidates.map((c, i) => (
            <Box key={c.value} gap={1}>
              <Text color={i === selClamped ? theme.accent : theme.dim}>
                {i === selClamped ? POINTER : " "}
              </Text>
              <Text color={i === selClamped ? theme.accent : undefined}>{c.label}</Text>
              {c.hint && <Text color={theme.dim}>{c.hint}</Text>}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// Render the buffer with a block cursor, wrapping across newlines.
function renderBuffer(value: string, cursor: number, placeholder: string): React.ReactNode {
  if (value.length === 0) {
    return (
      <Text wrap="truncate-end">
        <Text inverse> </Text>
        <Text color={theme.dim}>{placeholder}</Text>
      </Text>
    );
  }
  const lines = value.split("\n");
  let idx = 0;
  let curLine = 0;
  let curCol = cursor;
  for (let i = 0; i < lines.length; i++) {
    if (cursor <= idx + lines[i].length) {
      curLine = i;
      curCol = cursor - idx;
      break;
    }
    idx += lines[i].length + 1;
  }
  return lines.map((ln, i) => {
    if (i !== curLine) return <Text key={i}>{ln.length ? ln : " "}</Text>;
    const before = ln.slice(0, curCol);
    const at = ln.slice(curCol, curCol + 1) || " ";
    const after = ln.slice(curCol + 1);
    return (
      <Text key={i}>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    );
  });
}

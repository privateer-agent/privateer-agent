import { resolve, isAbsolute, relative, dirname, join, basename } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isProtectedPath } from "./protected.ts";
import type { PermissionRequest } from "./gate.ts";

// NEW glue for the Pi rewrite. In 0.2 each tool built its own PermissionRequest
// before calling ctx.gate.request(). Pi's `tool_call` hook instead hands us
// { toolName, input }, so the classification — which kind of action is this, does
// it touch a protected/outside path — moves here. Field extraction is defensive
// across Pi's builtin input shapes (command/cmd, path/file_path/file).
//
// Returns null when the call needs no gate (a read-only builtin acting inside
// scope, or a known-safe meta tool): the hook then lets it run untouched, so
// ordinary in-cwd work has zero friction.

export interface ScopeOptions {
  cwd: string;
  confineToCwd?: boolean; // default true
  allowedOutsideRoots?: string[];
}

// Resolve symlinks so an in-cwd symlink can't smuggle a path outside scope past the
// lexical `resolve()` check (P5-1: `resolve` normalizes `..` but does NOT follow
// symlinks, so `cwd/link/secret` where `link -> /etc` looks in-cwd lexically). We
// realpath the DEEPEST EXISTING ancestor — a write target's leaf may not exist yet —
// and re-append the missing tail; the escape lives in the existing prefix, so
// canonicalizing that is what matters. Falls back to the lexical path when nothing
// resolves (e.g. a fully-nonexistent tree, as in unit tests).
function realBase(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs; // reached the FS root without resolving → lexical
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

// ⚠️ SECURITY-CRITICAL: this MUST resolve a path string to exactly the same place
// Pi's file tools do, or the gate judges one file and the tool touches another.
//
// Pi resolves every tool path through `resolveToCwd` → `resolvePath` →
// `normalizePath` (node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js
// and dist/core/tools/path-utils.js), which EXPANDS `~`, STRIPS a leading `@`, and
// converts `file://` URLs. `node:path` treats all three as RELATIVE, so a classifier
// using bare resolve() computed `<cwd>/~/.ssh/authorized_keys` — comfortably "inside"
// the working directory — while `write` truly targeted `$HOME/.ssh/authorized_keys`.
// That made `outside` false and `protected` false (isProtectedPath matches basenames,
// and `authorized_keys` isn't one), so:
//   • reads returned null from classifyToolCall — NO gate at all, in every posture
//     including plan/readonly, at the default read-only tool ceiling; and
//   • writes auto-allowed under acceptEdits / bypass / no-quarter.
// The adversary here is the MODEL (prompt injection), not the user, so "the operator
// could read that file anyway" does not apply.
//
// Pi does not export normalizePath (package exports are "." and "./rpc-entry" only),
// so it is mirrored here. KEEP IN SYNC — tests/classifyPathParity.test.ts asserts this
// function agrees with Pi's own resolver, so a Pi upgrade that changes normalization
// fails the suite instead of silently reopening the hole.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeLikePi(input: string, opts: { unicodeSpaces?: boolean; stripAt?: boolean } = {}): string {
  let s = input;
  if (opts.unicodeSpaces) s = s.replace(UNICODE_SPACES, " ");
  if (opts.stripAt && s.startsWith("@")) s = s.slice(1);
  const home = homedir();
  if (s === "~") return home;
  if (s.startsWith("~/") || (process.platform === "win32" && s.startsWith("~\\"))) return join(home, s.slice(2));
  if (/^file:\/\//.test(s)) {
    // Pi lets fileURLToPath throw here, which fails the tool call. We must not throw
    // (that would break the gate), so fall back to the raw string: it then resolves
    // inside cwd, but the tool errors on the same input, so there is no divergence
    // a caller can exploit.
    try {
      return fileURLToPath(s);
    } catch {
      return s;
    }
  }
  return s;
}

function resolveInCwd(cwd: string, p: string): string {
  // Mirrors resolvePath(): the TARGET gets the tools' options
  // ({normalizeUnicodeSpaces, stripAtPrefix}); the BASE gets normalizePath's defaults
  // (tilde/file:// only), because Pi normalizes baseDir with no options.
  const target = normalizeLikePi(p, { unicodeSpaces: true, stripAt: true });
  const base = normalizeLikePi(cwd);
  return realBase(isAbsolute(target) ? resolve(target) : resolve(base, target));
}

function isInsideDir(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Outside the agent's working-directory scope? Only when confinement is on and the
// path is neither inside cwd nor inside a session-approved outside root. Both sides are
// symlink-canonicalized (realBase) so a symlinked cwd — or a symlink inside cwd — can't
// fake containment (P5-1).
export function isOutsideScope(scope: ScopeOptions, abs: string): boolean {
  if (scope.confineToCwd === false) return false;
  const target = realBase(abs);
  if (isInsideDir(realBase(scope.cwd), target)) return false;
  return !(scope.allowedOutsideRoots ?? []).some((root) => isInsideDir(realBase(root), target));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function firstPath(input: Record<string, unknown>): string {
  return str(input.path ?? input.file_path ?? input.file ?? input.filename ?? input.dir ?? input.directory);
}

// A write/edit tool call whose target path we can't statically extract — an aliased
// param name, or a patch tool whose target paths live in the DIFF BODY rather than a
// param (P5-4). Fail safe: mark it outside-scope so it prompts (in default/acceptEdits)
// instead of defaulting to a silent in-cwd auto-write. Precise patch-body path parsing
// needs Pi's apply_patch schema — TODO(verify) against the full builtin tool catalog.
function unknownTarget(toolName: string, kind: "write" | "edit"): PermissionRequest {
  return {
    tool: toolName,
    kind,
    title: kind === "write" ? "Write to an unverified path" : "Edit an unverified path",
    detail: "(target path not statically known — approve to allow)",
    outside: true,
  };
}

// Known-safe read-only / meta builtins that never mutate and never leave the
// machine: no gate regardless of arguments. Tunable — the conservative default for
// anything NOT listed here is to ask (see below). TODO(verify) against Pi's full
// builtin tool catalog as it's enumerated in Phase 5.
// `ask_user_question` (rpiv-ask-user-question, shimmed by the launcher) is here on
// purpose: it is a QUESTION PUT TO THE USER — it renders a dialog and returns what the
// human picked. It touches nothing, sends nothing, and the human is already in the loop
// by construction. Gating it would fall through to the unknown-tool branch below, which
// classifies as bash-kind: a pointless "Run ask_user_question" prompt in default mode,
// and an outright DENY in plan/readonly — the very posture where a model most needs to
// ask instead of guess. Headless surfaces need no guard either: the tool self-checks
// ctx.hasUI and returns an error result when there's no one to ask.
const NON_GATED = new Set([
  "todo", "todowrite", "todo_write", "todoread", "think", "plan_note",
  "ask_user_question",
]);

// Read-ish builtins: gated ONLY when the target resolves outside scope.
const READ_TOOLS = new Set(["read", "cat", "grep", "find", "glob", "ls", "tree", "view"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "str_replace", "str_replace_editor", "apply_patch", "patch"]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file", "create", "save_attachment"]);
const BASH_TOOLS = new Set(["bash", "shell", "run", "exec", "sh"]);

// Media tools (src/tools/media.ts, src/tools/videoCompose.ts). See the block in
// classifyToolCall — they are writes against a named output file, and the generation
// ones cost real money, which is what the title says out loud.
const MEDIA_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "generate_speech",
  "generate_music",
  "media_capabilities",
  "video_compose",
]);
// The generation tools egress model-chosen text (and any input file bytes) to
// Privateer's servers and onward to a provider — generate_music to one with no
// zero-retention endpoint — and each spends the account's credit. That egress +
// irreversible spend must never be auto-approved: classified as a plain `write`
// they were swallowed by acceptEdits (mode.ts:45) and by bypass/no-quarter, so a
// single injected call could leak context and bill the account with no dialog.
// `alwaysAsk` sits ABOVE bypass/acceptEdits/allowlist (mode.ts:37) and is never
// remembered, so every generation is a fresh human decision. video_compose is
// excluded on purpose — it is local ffmpeg, no egress and no spend — and
// media_capabilities is a read.
const MEDIA_GEN_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "generate_speech",
  "generate_music",
]);
const MEDIA_TITLES: Record<string, string> = {
  generate_image: "Generate an image (billed to your Privateer account)",
  generate_video: "Generate a video (billed to your Privateer account)",
  generate_speech: "Generate speech (billed to your Privateer account)",
  generate_music: "Generate music (billed; music prompts have no zero-retention option)",
  video_compose: "Compose video/audio locally",
  media_capabilities: "Read media capabilities",
};

export function classifyToolCall(
  toolName: string,
  input: unknown,
  scope: ScopeOptions,
): PermissionRequest | null {
  const name = toolName.toLowerCase();
  const obj: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (NON_GATED.has(name)) return null;

  // Creating a routine is a persistent mutation; surface the trigger + delivery, and
  // force a human decision (alwaysAsk) when it grants off-machine egress.
  if (name === "create_routine" || name === "routine") {
    const label = str(obj.name) || "routine";
    const trigger = obj.cron ? `cron ${str(obj.cron)}` : obj.at ? `at ${str(obj.at)}` : "(no trigger)";
    const delivery = Array.isArray(obj.delivery) ? (obj.delivery as unknown[]).map(String) : ["file"];
    const egress: string[] = [];
    if (delivery.includes("email")) egress.push("email leaves the machine");
    if (delivery.some((d) => d.startsWith("webhook:"))) egress.push("posts to a webhook off-machine");
    return {
      tool: toolName,
      kind: "write",
      title: "Create routine",
      detail: `${label}: ${trigger} → ${delivery.join(",")}${egress.length ? ` [${egress.join("] [")}]` : ""}`,
      alwaysAsk: egress.length > 0,
    };
  }

  // Media generation (src/tools/media.ts) and local composition (videoCompose.ts).
  //
  // Left to the unknown-tool branch at the bottom these classify as bash-kind, which
  // prompts with a JSON blob nobody can read and — worse — DENIES outright in plan and
  // readonly mode, where a media call is exactly as legitimate as any other write.
  // They are writes: each produces one named file, and the generation ones also spend
  // the account's credit, so the prompt should name the file and the cost.
  //
  // `outside` covers BOTH directions. The output is the obvious one. The inputs matter
  // just as much for the generation tools: `images: ["~/.ssh/id_rsa.png"]` would upload
  // a file from outside scope to our servers, so an out-of-scope INPUT has to prompt
  // even when the output lands neatly in cwd.
  if (MEDIA_TOOLS.has(name)) {
    const compose = name === "video_compose";
    const inputs = [
      ...(Array.isArray(obj.inputs) ? (obj.inputs as unknown[]).map(str) : []),
      str(obj.input),
      str(obj.audio),
      ...(Array.isArray(obj.images) ? (obj.images as unknown[]).map(str) : []),
      str(obj.firstFrame),
      str(obj.lastFrame),
    ].filter(Boolean);
    // Resolve each input once, then flag the two ways an input is sensitive: it leaves
    // the working directory, or it is a guarded file (.env, keys, credentials, …). The
    // generation tools base64 every input up to our servers, so a PROTECTED input is a
    // credential-exfil risk even when the output lands neatly in cwd — and the human
    // approving what looks like a thumbnail has to see which file is being read. Both
    // therefore feed `protected`/`outside` and are named in the prompt detail below.
    const resolvedInputs = inputs.map((p) => resolveInCwd(scope.cwd, p));
    const outsideInputs = resolvedInputs.filter((a) => isOutsideScope(scope, a));
    const protectedInputs = resolvedInputs.filter((a) => isProtectedPath(a));

    const outPath = str(obj.path ?? obj.output);
    // `probe` reads and writes nothing; so does any composition call with no output
    // (which the tool itself rejects). Gate those only when they touch a sensitive input.
    if (!outPath) {
      if (compose || name === "media_capabilities") {
        const flagged = protectedInputs[0] ?? outsideInputs[0];
        if (!flagged) return null;
        return {
          tool: toolName,
          kind: "read",
          title: protectedInputs.length > 0 ? "Read a protected file" : "Read outside working directory",
          detail: flagged,
          protected: protectedInputs.length > 0,
          outside: outsideInputs.length > 0,
          path: flagged,
        };
      }
      return unknownTarget(toolName, "write"); // a generation call with no destination
    }

    const absOut = resolveInCwd(scope.cwd, outPath);
    const outputOutside = isOutsideScope(scope, absOut);
    const outside = outputOutside || outsideInputs.length > 0;
    // Name the sensitive input in the prompt — protected first (the more dangerous
    // disclosure), then outside-scope. Base target is the output, absolute when it
    // itself leaves cwd, else the path the caller wrote.
    const inputNote = protectedInputs.length > 0
      ? ` (reads protected file ${protectedInputs[0]}${protectedInputs.length > 1 ? ` +${protectedInputs.length - 1} more` : ""})`
      : outsideInputs.length > 0
        ? ` (reads ${outsideInputs[0]}, outside the working directory)`
        : "";
    return {
      tool: toolName,
      kind: "write",
      title: outside
        ? `${MEDIA_TITLES[name]} outside working directory`
        : MEDIA_TITLES[name],
      detail: `${outputOutside ? absOut : outPath}${inputNote}`,
      protected: isProtectedPath(absOut) || protectedInputs.length > 0,
      outside,
      alwaysAsk: MEDIA_GEN_TOOLS.has(name),
      path: absOut,
    };
  }

  // Shell — the whole command is the detail (danger scanning runs on it).
  if (BASH_TOOLS.has(name)) {
    const command = str(obj.command ?? obj.cmd ?? obj.script);
    return { tool: toolName, kind: "bash", title: "Run command", detail: command };
  }

  // Write — create/overwrite a file.
  if (WRITE_TOOLS.has(name)) {
    const p = firstPath(obj);
    if (!p) return unknownTarget(toolName, "write"); // P5-4: no extractable path → fail safe
    const abs = resolveInCwd(scope.cwd, p);
    const outside = isOutsideScope(scope, abs);
    return {
      tool: toolName,
      kind: "write",
      title: outside ? "Write outside working directory" : "Write file",
      detail: outside ? abs : p,
      protected: isProtectedPath(abs),
      outside,
      path: abs,
    };
  }

  // Edit — modify an existing file.
  if (EDIT_TOOLS.has(name)) {
    const p = firstPath(obj);
    if (!p) return unknownTarget(toolName, "edit"); // P5-4: no extractable path → fail safe
    const abs = resolveInCwd(scope.cwd, p);
    const outside = isOutsideScope(scope, abs);
    return {
      tool: toolName,
      kind: "edit",
      title: outside ? "Edit outside working directory" : "Edit file",
      detail: outside ? abs : p,
      protected: isProtectedPath(abs),
      outside,
      path: abs,
    };
  }

  // Read-ish — no gate in scope; when the target is outside scope, prompt.
  if (READ_TOOLS.has(name)) {
    const p = firstPath(obj);
    if (!p) return null; // e.g. grep with no explicit path → in-cwd, no gate
    const abs = resolveInCwd(scope.cwd, p);
    if (!isOutsideScope(scope, abs)) return null;
    return {
      tool: toolName,
      kind: "read",
      title: "Read outside working directory",
      detail: abs,
      outside: true,
      path: abs,
    };
  }

  // Network reads (web fetch / search / http).
  if (name.includes("fetch") || name.includes("web") || name.includes("http") || name.includes("url")) {
    return {
      tool: toolName,
      kind: "fetch",
      title: "Fetch from the network",
      detail: str(obj.url ?? obj.query ?? obj.q),
    };
  }

  // Unknown / custom / MCP tool: we can't prove it's side-effect-free, so
  // safe-by-default is to prompt. Classified as a bash-kind action (asks in
  // default/acceptEdits, denies in plan, allows only under bypass). Phase 5 refines
  // this with MCP destructiveHint → alwaysAsk and a per-tool policy map.
  return {
    tool: toolName,
    kind: "bash",
    title: `Run ${toolName}`,
    detail: safeJson(obj),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

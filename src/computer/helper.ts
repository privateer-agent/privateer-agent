/**
 * The platform helper — one long-lived child process that owns the screen and the
 * input devices, spoken to in newline-delimited JSON over stdin/stdout.
 *
 * WHY A SEPARATE PROCESS AT ALL. Every OS puts GUI control behind a native API that
 * Node cannot reach without a compiled addon: CGEvent/ScreenCaptureKit on macOS,
 * SendInput/BitBlt on Windows, the X11 or Wayland protocols on Linux. The alternative
 * to a helper is an npm native module (nut.js, robotjs), which means a prebuilt binary
 * per platform AND per architecture riding in node_modules — fighting the pinned-Node
 * self-contained bundles, code signing and notarization, and the Intel/ARM mac split
 * that has already cost us one bad release. A helper we compile ourselves is one file
 * per platform, signed with the app, with no install-time build step anywhere.
 *
 * WHY LONG-LIVED, not a process per action. Three reasons, all load-bearing:
 *   • TCC. macOS attributes Screen Recording and Accessibility grants to a process's
 *     signing identity; one persistent helper prompts the user once, where a
 *     process-per-click would make consent state harder to reason about and the
 *     latency of each grant check real.
 *   • Latency. A GUI loop is screenshot → think → click → screenshot, dozens of times.
 *     Paying ~80ms of process spawn on each one is most of a second per interaction.
 *   • The coordinate space. Resolution and downscale live in ONE conversation with ONE
 *     process, so the frame the model saw and the click that follows it cannot be
 *     served by two helpers that disagree (computer/space.ts explains why that matters
 *     more here than anywhere else).
 *
 * DEGRADING IS THE NORMAL CASE, NOT AN ERROR PATH. Phase 1 ships this client and no
 * binaries; a platform with no helper must say so in a sentence the model can relay,
 * the way `sfx.configured: false` and the sprite pipeline's ffmpeg probe already do —
 * never fail at the moment of use with a spawn error, and never after having promised
 * the user it would work.
 *
 * A FAILED PROBE IS RETRIED, NOT LATCHED. Same reasoning as
 * services/sprites/frameExtract.js: a spawn can fail for reasons unrelated to the
 * binary being absent (a grant not yet given, a helper still being installed by an
 * update), and caching that would take screen control down until the process restarts.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturePlan, Display } from "./space.ts";

/** Point the client at a specific helper binary. The desktop shell sets this to the copy inside its app bundle. */
export const HELPER_PATH_ENV = "PRIVATEER_COMPUTER_HELPER";

/** The name the helper ships under, on PATH or beside the bundle. */
const HELPER_BIN = process.platform === "win32" ? "privateer-computer.exe" : "privateer-computer";

/** A helper call that hasn't answered in this long is treated as wedged. Generous: a capture on a large display is real work. */
const CALL_TIMEOUT_MS = 20_000;
/** How long a failed spawn is remembered before we try again. */
const PROBE_COOLDOWN_MS = 30_000;

// ─── Wire protocol ───────────────────────────────────────────────────────────
// Requests carry an `id` the reply echoes; nothing here assumes replies arrive in
// order, because a capture and a grant check legitimately overlap.

export interface CaptureRequest {
  op: "capture";
  display: string;
  /** The helper resizes natively to exactly this — see computer/space.ts on why the helper, not us. */
  targetWidth: number;
  targetHeight: number;
  /**
   * Optionally, a SECOND much smaller copy of the same grab, for the permission dialog.
   *
   * Asked for in the same call rather than taken separately, and that is the whole
   * point: a second capture would be a second moment in time, so the picture a person
   * approves a click against could show a screen the model never saw. One grab, two
   * encodings — every helper already has the resize step.
   */
  previewWidth?: number;
  previewHeight?: number;
}

export type PointerAction = "move" | "click" | "double_click" | "down" | "up" | "drag" | "scroll";
export type MouseButton = "left" | "right" | "middle";

export interface PointerRequest {
  op: "pointer";
  action: PointerAction;
  /**
   * Which display the coordinates belong to. REQUIRED, and not a convenience: x/y are
   * local to one display's own device pixels, because a global device-pixel space does
   * not exist on a mixed-DPI desktop (computer/space.ts, Display.originX). The helper
   * knows that display's bounds and scale and is the only thing that converts into the
   * OS's global point space.
   */
  display: string;
  /** DEVICE pixels, origin at this display's top-left. From computer/space.ts and nowhere else. */
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  button?: MouseButton;
  scrollX?: number;
  scrollY?: number;
}

export interface KeyRequest {
  op: "key";
  action: "type" | "press";
  /** Literal text to type, for action "type". */
  text?: string;
  /** A chord such as "cmd+shift+4" or a named key such as "return", for action "press". */
  keys?: string;
}

export type HelperRequest =
  | { op: "displays" }
  | { op: "grants" }
  | CaptureRequest
  | PointerRequest
  | KeyRequest;

/** What the OS currently permits. Every field is a fact about this machine, not a preference. */
export interface Grants {
  /** Screen Recording (macOS TCC) or equivalent. False ⇒ capture returns a black or empty frame. */
  screen: boolean;
  /** Accessibility (macOS) / uiAccess (Windows). False ⇒ synthesized input is silently dropped by the OS. */
  input: boolean;
  /**
   * A password field somewhere has secure input enabled. The OS suppresses synthesized
   * keystrokes entirely while this is on, so a `type` would appear to succeed and put
   * nothing anywhere. Reported so the refusal can name the real cause.
   */
  secureInput: boolean;
  /** pid of the frontmost application, for the self-click interlock in tools/computer.ts. */
  frontmostPid?: number;
}

export interface CaptureResult {
  mimeType: string;
  /** base64 — handed to the model as an ImageContent block. */
  data: string;
  width: number;
  height: number;
  /** base64 PNG at the requested preview size, when one was asked for and produced. */
  preview?: string;
}

/** Why screen control isn't available here. Written for a user to read, not a log. */
export interface Unavailable {
  available: false;
  reason: string;
}
export interface Available {
  available: true;
}
export type Availability = Available | Unavailable;

// ─── Locating the helper ─────────────────────────────────────────────────────
//
// THREE SHAPES, not one, and the difference is the platform's own. macOS needs a
// compiled binary (CGEvent has no scriptable equivalent), so it ships as a signed
// artifact inside the desktop app — the ONE helper the CLI does not carry. Windows and
// Linux are served by a PowerShell script and a Node script, which ride in this package
// and therefore work for the CLI as well as the app.

/** How to start the helper: a command, its arguments, and any environment it needs. */
export interface HelperCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The mode a helper is being started in. `serve` is the long-lived protocol loop. */
export type HelperMode = "serve" | "grants";

function nativeDir(): string {
  // src/computer → the package root, then native/. Present in the npm package (see the
  // `files` list) and inside the desktop's bundled copy of this package.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
}

/**
 * The Node to run a .mjs helper with.
 *
 * Under Electron `process.execPath` is the app, not Node — so it is re-entered as Node
 * through ELECTRON_RUN_AS_NODE, the same accommodation desktop/scripts already make for
 * the CLI shim. Getting this wrong would launch a second copy of the whole application
 * per session, which is a spectacular failure rather than a quiet one, but a failure
 * worth not having.
 */
function nodeCommand(): { command: string; env?: Record<string, string> } {
  const electron = !!(process as any).versions?.electron;
  return electron
    ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { command: process.execPath };
}

function scriptCommand(script: string, mode: HelperMode): HelperCommand {
  if (script.endsWith(".ps1")) {
    // -NoProfile so a user's PowerShell profile cannot print into our protocol stream;
    // -NonInteractive so nothing can block waiting for input that will never come;
    // -ExecutionPolicy Bypass because the default policy refuses unsigned local scripts
    // and this one ships inside a package rather than being signed on its own.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", script,
        mode === "serve" ? "-Serve" : "-Grants",
      ],
    };
  }
  const node = nodeCommand();
  return { command: node.command, args: [script, `--${mode}`], env: node.env };
}

/** Candidate paths for the compiled macOS helper, in the order they should win. */
function bundledCandidates(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return [
    join(root, "build-resources", "bin", process.platform, HELPER_BIN),
    join(root, "bin", HELPER_BIN),
  ];
}

/**
 * How to start the helper on this machine, or undefined when there is none.
 *
 * The explicit override wins over everything, and on macOS that is the ordinary case:
 * the desktop points it at the signed copy inside its own app bundle. That matters
 * beyond tidiness — a signed helper inside the bundle inherits the app's TCC identity,
 * where a stray `privateer-computer` on PATH is a different binary whose grants the user
 * would have to give again, discovering the problem only as the feature not working.
 */
export function findHelper(mode: HelperMode = "serve"): HelperCommand | undefined {
  const override = process.env[HELPER_PATH_ENV]?.trim();
  if (override) {
    if (!existsSync(override)) return undefined;
    if (override.endsWith(".ps1") || override.endsWith(".mjs")) return scriptCommand(override, mode);
    return { command: override, args: [`--${mode}`] };
  }

  if (process.platform === "win32") {
    const script = join(nativeDir(), "win", "PrivateerComputer.ps1");
    return existsSync(script) ? scriptCommand(script, mode) : undefined;
  }

  if (process.platform === "linux") {
    const script = join(nativeDir(), "linux", "privateer-computer.mjs");
    return existsSync(script) ? scriptCommand(script, mode) : undefined;
  }

  for (const c of bundledCandidates()) {
    if (existsSync(c)) return { command: c, args: [`--${mode}`] };
  }
  return undefined;
}

/**
 * Platform-specific truth about why there is no helper. Worth saying precisely, because
 * "screen control unavailable" with no reason is what sends someone hunting through
 * settings that are already correct.
 *
 * Note the Linux and Windows cases are about the helper SCRIPT being absent, which
 * should not happen in a working install — the interesting Linux failures (no xdotool,
 * a GNOME Wayland session) are reported by the helper itself, which is the only thing
 * that can see them.
 */
function missingReason(): string {
  switch (process.platform) {
    case "darwin":
      return (
        "The macOS screen-control helper isn't installed with this build. It ships with the " +
        "Privateer desktop app; the command-line agent does not carry it. Once installed it " +
        "also needs Screen Recording and Accessibility permission in System Settings."
      );
    case "win32":
      return "The Windows screen-control helper is missing from this installation.";
    case "linux":
      return "The Linux screen-control helper is missing from this installation.";
    default:
      return `Screen control has no helper for ${process.platform}.`;
  }
}

// ─── The client ──────────────────────────────────────────────────────────────

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One helper connection. Created per session (tools/computer.ts holds it in a closure,
 * never at module scope — the desktop runs several sessions in ONE process and a shared
 * helper would let one window's coordinate state answer another window's click).
 */
export class ComputerHelper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private lastFailureAt = 0;
  private lastFailure = "";

  /** Whether a helper can be reached right now, and if not, why — in a sentence a user can act on. */
  availability(): Availability {
    if (this.child && !this.child.killed) return { available: true };
    if (!findHelper()) return { available: false, reason: missingReason() };
    if (this.lastFailure && Date.now() - this.lastFailureAt < PROBE_COOLDOWN_MS) {
      return { available: false, reason: this.lastFailure };
    }
    return { available: true };
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const helper = findHelper("serve");
    if (!helper) throw new Error(missingReason());

    const child = spawn(helper.command, helper.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: helper.env ? { ...process.env, ...helper.env } : process.env,
    });
    this.child = child;
    this.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // The helper's stderr is diagnostics, never a reply. Kept off the model's context
    // on purpose: it carries window titles and application names from whatever is on
    // screen, which is exactly the untrusted text we don't want reaching a planner.
    child.stderr.resume();

    const fail = (message: string) => {
      this.lastFailure = message;
      this.lastFailureAt = Date.now();
      this.child = undefined;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
      }
      this.pending.clear();
    };

    child.on("error", (err) => fail(`The screen-control helper could not start: ${err.message}`));
    child.on("exit", (code, signal) =>
      fail(`The screen-control helper stopped (${signal ?? `exit ${code}`}).`),
    );
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a helper that writes noise to stdout must not wedge every caller
      }
      const p = this.pending.get(msg?.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(String(msg.error ?? "the helper refused")));
      else p.resolve(msg);
    }
  }

  private call<T>(req: HelperRequest): Promise<T> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The screen-control helper did not answer ${req.op} in ${CALL_TIMEOUT_MS / 1000}s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  }

  async displays(): Promise<Display[]> {
    const r = await this.call<{ displays: Display[] }>({ op: "displays" });
    return r.displays ?? [];
  }

  async grants(): Promise<Grants> {
    const r = await this.call<{ grants: Grants }>({ op: "grants" });
    return r.grants ?? { screen: false, input: false, secureInput: false };
  }

  /** Capture `plan`'s display, downscaled by the helper to exactly the plan's agent-space size. */
  async capture(plan: CapturePlan, preview?: { width: number; height: number }): Promise<CaptureResult> {
    return this.call<CaptureResult>({
      op: "capture",
      display: plan.displayId,
      targetWidth: plan.width,
      targetHeight: plan.height,
      ...(preview ? { previewWidth: preview.width, previewHeight: preview.height } : {}),
    });
  }

  async pointer(req: Omit<PointerRequest, "op">): Promise<void> {
    await this.call({ op: "pointer", ...req });
  }

  async key(req: Omit<KeyRequest, "op">): Promise<void> {
    await this.call({ op: "key", ...req });
  }

  /** Stop the helper. Called when a session ends so a closed window leaves no process holding the screen. */
  dispose(): void {
    const child = this.child;
    this.child = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("The session ended."));
    }
    this.pending.clear();
    child?.kill();
  }
}

/**
 * The approval preview sink — how the picture reaches the permission prompt.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * The gate classifies a tool call from `{ toolName, input }` and nothing else
 * (permissions/classify.ts). That is the right shape for every other kind: a path, a
 * command and a URL are all IN the input. A click is not — `{x: 812, y: 344}` means
 * nothing without the screenshot those coordinates are relative to, and that screenshot
 * lives in the closure of tools/computer.ts, which the classifier cannot reach and
 * should not learn about.
 *
 * So the frame travels through an object both halves are handed: the tools write the
 * last capture in, the gate extension reads a preview out. One per session.
 *
 * ── Why not module state, one more time ──────────────────────────────────────
 *
 * It would be two lines shorter and it would be a real bug. The desktop runs one
 * session PER WINDOW inside a single process, so a module-level "last frame" would let
 * one window's screenshot illustrate another window's approval — showing a person a
 * picture of the wrong screen and asking them to approve a click on it. That is worse
 * than showing no picture at all, because it looks like it worked. The sink is created
 * per session in buildMoat and handed to exactly the two things that need it, the same
 * way relayFiles.bridge already is.
 *
 * ── Bounded on purpose ───────────────────────────────────────────────────────
 *
 * One frame per display, replaced on each capture, never accumulated. A GUI loop takes
 * dozens of screenshots per task; keeping a history would grow a session's memory
 * without anyone asking for it, and the only frame an approval can honestly be
 * illustrated with is the most recent one for that display anyway — the model's
 * coordinates are relative to that and nothing else.
 */

import type { ApprovalPreview } from "../permissions/gate.ts";

/** One display's most recent frame, downscaled for a dialog. */
export interface PreviewFrame {
  displayId: string;
  /** base64 PNG at preview size, not the full frame the model received. */
  data: string;
  width: number;
  height: number;
  /** The AGENT-space dimensions the tool's coordinates are in. */
  frameWidth: number;
  frameHeight: number;
}

/** The pointer actions worth drawing a marker for. Others get the picture alone. */
const POINTER_ACTIONS = new Set(["click", "double_click", "right_click", "move", "drag", "scroll"]);

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export class ComputerPreviewSink {
  private frames = new Map<string, PreviewFrame>();
  /** The display captured most recently, so an action that omits `display` still illustrates. */
  private lastDisplayId: string | undefined;

  /** Record a capture. Replaces whatever that display had. */
  put(frame: PreviewFrame): void {
    this.frames.set(frame.displayId, frame);
    this.lastDisplayId = frame.displayId;
  }

  /** Forget everything — called when a session's helper is disposed. */
  clear(): void {
    this.frames.clear();
    this.lastDisplayId = undefined;
  }

  /**
   * Build the preview for a pending `computer_control` call, or undefined when there is
   * nothing honest to show.
   *
   * Resolves the display exactly as the tool does — the named one, else the last
   * captured — so the picture in the dialog is the picture the coordinates are against.
   * If those two ever disagreed the dialog would be actively misleading, which is the
   * one outcome worse than a text-only prompt.
   */
  previewFor(toolName: string, input: unknown): ApprovalPreview | undefined {
    if (toolName !== "computer_control") return undefined;
    const obj: Record<string, unknown> =
      input && typeof input === "object" ? (input as Record<string, unknown>) : {};

    const action = typeof obj.action === "string" ? obj.action : undefined;
    // `type`, `key` and `wait` have no location, and a picture with no marker invites
    // the reader to look for one. They keep the text-only prompt, where the detail line
    // already carries the whole decision (the literal text, verbatim).
    if (!action || !POINTER_ACTIONS.has(action)) return undefined;

    const displayId = typeof obj.display === "string" && obj.display ? obj.display : this.lastDisplayId;
    const frame = displayId ? this.frames.get(displayId) : undefined;

    const x = num(obj.x);
    const y = num(obj.y);
    const toX = num(obj.to_x);
    const toY = num(obj.to_y);

    // A frame with no coordinates, or coordinates with no frame, are both still worth
    // sending: the picture alone tells someone which screen this is about, and a marker
    // position with no picture is dropped harmlessly by the renderer.
    if (!frame && x === undefined) return undefined;

    return {
      action,
      ...(frame
        ? {
            image: {
              data: frame.data,
              width: frame.width,
              height: frame.height,
              frameWidth: frame.frameWidth,
              frameHeight: frame.frameHeight,
            },
          }
        : {}),
      ...(x !== undefined && y !== undefined ? { target: { x, y } } : {}),
      ...(action === "drag" && toX !== undefined && toY !== undefined ? { to: { x: toX, y: toY } } : {}),
    };
  }
}

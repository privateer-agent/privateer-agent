/**
 * The coordinate space — the one thing in GUI control that has to be exactly right.
 *
 * WHY THIS IS ITS OWN MODULE, AND PURE. Three different pixel grids are in play at
 * once and nothing in the system tells you when you have mixed them up:
 *
 *   • DEVICE pixels — what the display actually has. A 16" Retina panel is 3456×2234.
 *   • POINTS — what macOS's input APIs take (CGEvent), half that on a 2× display.
 *   • AGENT space — the grid of the downscaled PNG the model is actually looking at.
 *     A 3456px-wide frame is ~5 MB of base64 and more pixels than any vision model
 *     resolves; every implementation downscales, so the model's coordinates are in a
 *     space that exists nowhere in the OS.
 *
 * The failure mode is not a crash. If capture scales and input does not, every click
 * lands at roughly half or twice the intended place, the model sees a screenshot where
 * nothing happened, and it tries again slightly differently — burning tokens and money
 * while quietly clicking on whatever else is there. That is the single most expensive
 * bug this feature can have, so the rule is:
 *
 *   EVERY coordinate crossing the tool boundary is in AGENT space, and the ONLY
 *   conversion to device pixels happens here.
 *
 * The helper is told the target size up front and does the downscale natively (a
 * CoreGraphics resize is far cheaper than shipping a full-resolution PNG down a pipe
 * and resampling it in JS), so the image the model receives IS agent space by
 * construction rather than by a second calculation that could disagree with this one.
 *
 * TWO factors, not one. Rounding the target size means `regionWidth / factor` is not
 * generally an integer, so a single factor leaves a fractional error that grows toward
 * the far edge of the screen — precisely where a click is most likely to miss (a menu
 * bar item, a window's close button). Deriving the factor per-axis FROM the rounded
 * size instead makes the mapping exact at both edges.
 *
 * PIXEL CENTRES, not corners. `a * factor` biases every click toward the top-left of
 * the cell it names and can land exactly on a boundary; `(a + 0.5) * factor` lands in
 * the middle of the agent pixel the model pointed at.
 *
 * ONE DISPLAY AT A TIME. Every coordinate here is local to a single display, because a
 * global device-pixel space does not exist on a mixed-DPI desktop — see Display.originX
 * for the collision that makes. Turning a display-local device pixel into something the
 * OS will accept is the platform helper's job, and only its job.
 *
 * Pure — no I/O, no platform calls — so tests/computer.test.ts can pin the round trip
 * over the display shapes that actually ship (1×, 2×, ultrawide, a small panel) rather
 * than only the one on the developer's desk.
 */

/** A display as the platform helper reports it. All lengths in DEVICE pixels. */
export interface Display {
  /** Stable within a session; what the tools' `display` parameter names. */
  id: string;
  /** Human label for the approval prompt — "Built-in Retina Display". */
  label: string;
  width: number;
  height: number;
  /** Device pixels per point. 2 on Retina, 1 on a plain panel, 1.5 on some Windows. */
  scale: number;
  /**
   * Where this display sits in the global desktop, in POINTS — the space the operating
   * system lays displays out in, and the space its input APIs take. A display placed to
   * the LEFT of the primary has a negative originX.
   *
   * INFORMATIONAL ONLY: nothing in this module converts through it, and the tools never
   * send it anywhere. It is here so a capability listing can say where a screen is.
   *
   * WHY NOT DEVICE PIXELS, which is what an earlier version of this file used. There is
   * no coherent global device-pixel space on a mixed-DPI desktop. Multiply each
   * display's point origin by its OWN scale and the ranges collide: a 2x laptop
   * (3456px / 1728pt wide) at origin 0 owns device px 0-3455, while a 1x monitor placed
   * beside it at point origin 1728 would claim 1728-4287 — so half of one screen's
   * coordinates also name the other's, and a click meant for the second monitor lands
   * on the first. Every coordinate below is therefore LOCAL to one display, and the
   * platform helper — which knows that display's bounds and scale — is the only thing
   * that converts into the OS's global space.
   */
  originX: number;
  originY: number;
  primary: boolean;
}

/**
 * The mapping between one captured frame and the display it came from. Built by
 * planCapture, handed to the helper as the capture request, and kept for as long as
 * the model might send coordinates back against that frame.
 */
export interface CapturePlan {
  displayId: string;
  /** Agent space: the exact pixel size of the image the model is shown. */
  width: number;
  height: number;
  /** Agent px → device px, per axis. Derived from the rounded size; see the header. */
  factorX: number;
  factorY: number;
  /** The captured region's size in device px (today: the whole display). */
  regionWidth: number;
  regionHeight: number;
}

/** A point in agent space — the grid of the frame the model was shown. */
export interface AgentPoint {
  x: number;
  y: number;
}

/**
 * A point in ONE display's own device pixels, origin at that display's top-left. What
 * the helper is given, alongside the display id — see Display.originX for why this is
 * never a global coordinate.
 */
export interface DevicePoint {
  x: number;
  y: number;
}

/**
 * The longest edge, in agent pixels, a captured frame is reduced to.
 *
 * 1400 is chosen against what the models can actually resolve rather than what looks
 * nice: Claude tiles vision input at roughly 1.15k on the long edge and gains nothing
 * above ~1568, and a 1400px frame of a 2× display is a 2:1 reduction — enough that
 * menu-bar text is still legible when the model needs to read it. Raising this costs
 * tokens on every single screenshot in a loop that takes many; lowering it makes small
 * UI unreadable and the model start guessing.
 */
export const DEFAULT_MAX_EDGE = 1400;

/** Bounds on what a caller may ask for, so one tool call can't blow up a turn's budget. */
export const MIN_MAX_EDGE = 320;
export const MAX_MAX_EDGE = 2400;

export function clampMaxEdge(requested: number | undefined): number {
  if (!Number.isFinite(requested as number)) return DEFAULT_MAX_EDGE;
  return Math.min(MAX_MAX_EDGE, Math.max(MIN_MAX_EDGE, Math.round(requested as number)));
}

/**
 * Work out the agent space for capturing `display` whole.
 *
 * Never upscales: a small display stays at its native size (factor 1) rather than being
 * blown up to the max edge, which would cost tokens for pixels that carry no detail.
 */
export function planCapture(display: Display, maxEdge: number = DEFAULT_MAX_EDGE): CapturePlan {
  const edge = clampMaxEdge(maxEdge);
  const longest = Math.max(display.width, display.height);
  const reduction = longest > edge ? longest / edge : 1;

  // At least 1px each way — a degenerate display report must not produce a zero-sized
  // plan whose factors are Infinity.
  const width = Math.max(1, Math.round(display.width / reduction));
  const height = Math.max(1, Math.round(display.height / reduction));

  return {
    displayId: display.id,
    width,
    height,
    factorX: display.width / width,
    factorY: display.height / height,
    regionWidth: display.width,
    regionHeight: display.height,
  };
}

/**
 * The longest edge of the small copy sent with a permission prompt.
 *
 * Deliberately far below DEFAULT_MAX_EDGE. The model needs to read menu text; a human
 * approving a click needs to recognise the window and see where the marker is, which
 * 480px does at a glance. It also has to cross a relay to a phone for every single
 * action — the full frame is ~1 MB of base64 and this is nearer 40 KB, and an approval
 * that takes a second to arrive is one people stop reading.
 */
export const PREVIEW_MAX_EDGE = 480;

/** The preview's pixel size for a given plan, preserving its aspect. */
export function planPreview(plan: CapturePlan, maxEdge: number = PREVIEW_MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(plan.width, plan.height);
  const reduction = longest > maxEdge ? longest / maxEdge : 1;
  return {
    width: Math.max(1, Math.round(plan.width / reduction)),
    height: Math.max(1, Math.round(plan.height / reduction)),
  };
}

/** Is this point inside the frame the model was actually shown? */
export function isInFrame(pt: AgentPoint, plan: CapturePlan): boolean {
  return (
    Number.isFinite(pt.x) &&
    Number.isFinite(pt.y) &&
    pt.x >= 0 &&
    pt.y >= 0 &&
    pt.x < plan.width &&
    pt.y < plan.height
  );
}

/**
 * Math.round produces -0 for any input in [-0.5, 0), which is what the top-left corner
 * of a frame maps back to. It compares equal to 0 with `==` and survives JSON, so it
 * would never have shown up in behaviour — but it is not 0 under Object.is or a strict
 * deep-equal, so it turns any future test or cache key over a coordinate into a
 * mismatch that reads as a real bug. Normalized once, here.
 */
function norm(v: number): number {
  return v + 0;
}

/**
 * One agent pixel's device coordinate: the device pixel nearest the middle of the cell
 * that agent pixel covers, CONSTRAINED to that cell.
 *
 * The constraint is the whole point, and two simpler versions both fail:
 *
 *   • round(origin + (a + 0.5) * factor) overshoots at the far edge. A 1024-wide
 *     display at factor 1 sends its rightmost pixel (1023) to round(1023.5) = 1024 —
 *     the first pixel of the NEXT display. A click on a window's close button or a
 *     right-edge scrollbar lands on the monitor beside it.
 *   • floor(...) fixes that and breaks the round trip, because flooring the centre can
 *     leave the cell it came from: at factor 1.44036, agent row 1549 covers device
 *     [2231.12, 2232.56), its centre is 2231.84, and floor gives 2231 — which is row
 *     1548. Off by one, over most of the screen rather than at its edge.
 *
 * Deriving the cell's integer bounds and clamping into them is exact for both. Since
 * planCapture never upscales, factor >= 1 and every cell contains at least one integer,
 * so the clamp always has something to land on.
 */
function cellDevice(index: number, factor: number): number {
  const lo = Math.ceil(index * factor);
  const hi = Math.ceil((index + 1) * factor) - 1;
  const centre = Math.round((index + 0.5) * factor);
  if (hi < lo) return lo; // a sub-pixel cell — impossible today, but not worth a NaN
  return Math.min(hi, Math.max(lo, centre));
}

/**
 * Agent space → the global desktop, in device pixels.
 *
 * THROWS on a point outside the frame rather than clamping to the edge. An edge-clamped
 * click is a plausible-looking place that is not where the model aimed, and the model
 * would read the resulting screenshot as "the click did something unexpected" instead
 * of "my coordinates were wrong". An out-of-frame point is always a mistake, and saying
 * so is what stops the retry loop this whole module exists to prevent.
 */
export function agentToDevice(pt: AgentPoint, plan: CapturePlan): DevicePoint {
  if (!isInFrame(pt, plan)) {
    throw new RangeError(
      `(${pt.x}, ${pt.y}) is outside the captured frame, which is ${plan.width}×${plan.height}. ` +
        `Coordinates must come from the most recent screen_capture of this display.`,
    );
  }
  return {
    x: norm(cellDevice(pt.x, plan.factorX)),
    y: norm(cellDevice(pt.y, plan.factorY)),
  };
}

/**
 * The inverse — which agent pixel's cell contains this device point. Used to report the
 * pointer's current position back in the space the model is thinking in.
 *
 * `floor` of the offset, not a rounded centre: the cell for index a is
 * [origin + a*factor, origin + (a+1)*factor), so this is the exact inverse of
 * cellDevice above rather than an approximation that agrees with it most of the time.
 */
export function deviceToAgent(pt: DevicePoint, plan: CapturePlan): AgentPoint {
  return {
    x: norm(Math.floor(pt.x / plan.factorX)),
    y: norm(Math.floor(pt.y / plan.factorY)),
  };
}

/** Pick the display a tool call means: the one named, else the primary, else the first. */
export function resolveDisplay(displays: Display[], id: string | undefined): Display | undefined {
  if (!displays.length) return undefined;
  if (id) return displays.find((d) => d.id === id);
  return displays.find((d) => d.primary) ?? displays[0];
}

/** One line per display for computer_capabilities — sizes in the space the model uses. */
export function describeDisplays(displays: Display[], maxEdge: number = DEFAULT_MAX_EDGE): string[] {
  return displays.map((d) => {
    const plan = planCapture(d, maxEdge);
    const scale = d.scale !== 1 ? ` @${d.scale}×` : "";
    const primary = d.primary ? " (primary)" : "";
    return (
      `  ${d.id}: ${d.label}${primary} — ${d.width}×${d.height} device px${scale}; ` +
      `you will see it as ${plan.width}×${plan.height} and give coordinates in that space`
    );
  });
}

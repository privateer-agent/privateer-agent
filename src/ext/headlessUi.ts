/**
 * A COMPLETE ExtensionUIContext for surfaces that have no terminal UI.
 *
 * Pi decides `ctx.hasUI` by identity — `hasUI() { return this.uiContext !== noOpUIContext }`
 * (pi-coding-agent core/extensions/runner.js). So binding ANY object flips hasUI to true,
 * and every extension that guards on `ctx.hasUI` then calls the FULL ExtensionUIContext
 * surface on it. Our callers only ever implemented the four dialog methods they cared
 * about (select/confirm/input/notify), which is how a harbor session ended up throwing
 *
 *     MCP initialization failed: ui.setStatus is not a function
 *
 * — pi-mcp-adapter saw hasUI true, called ctx.ui.setStatus() to draw its status bar, and
 * the whole MCP init aborted, taking every connector's tools with it. The session still
 * ran; it just silently had no MCP tools.
 *
 * The fix is to always hand Pi a complete context: no-op defaults for the presentational
 * surface (status bars, widgets, footers, editor manipulation — none of which mean
 * anything without a terminal), the caller's real implementations for the dialogs that
 * relay to the app, and a Proxy backstop so a method added by a future Pi release
 * degrades to a no-op instead of crashing extension init all over again.
 *
 * Deliberately NOT a security boundary: hasUI stays true for these callers exactly as
 * before. The permission gate (ext/permissionGate.ts) makes its own hasUI/ui check and
 * fails closed on its own terms — nothing here loosens that.
 */

// The presentational half of ExtensionUIContext, mirroring pi-coding-agent's private
// noOpUIContext. Kept as data (not a class) so `createUIContext` can spread it.
const NO_OP_UI = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "UI not available" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

/**
 * A passthrough stand-in for Pi's Theme singleton, which lives behind a deep path the
 * package's `exports` map doesn't expose (and `initTheme()` returns void — it only
 * initializes that private singleton). Extensions call `ui.theme.fg("accent", text)` to
 * colorize, so the shape has to exist.
 *
 * Returning the text unstyled is the RIGHT answer here rather than a lossy stub: this
 * context is used where output goes to a log file or across the relay to the app's feed,
 * and injected ANSI escapes would be noise in the first case and are actively unwanted in
 * the second (the CLI already redacts/escapes what crosses that wire).
 */
export const passthroughTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "256color" as const,
  getThinkingBorderColor: () => (s: string) => s,
  getBashModeBorderColor: () => (s: string) => s,
};

// Any property we didn't anticipate resolves to a no-op function. Extensions call UI
// members as methods, so a callable is the shape that keeps them running; the cost of
// guessing wrong is a missing visual, versus a thrown TypeError that aborts init.
const unknownMember = () => () => undefined;

/**
 * Build a full ExtensionUIContext from the dialog methods a caller actually implements.
 *
 * `overrides` typically carries select/confirm/input/notify wired to the relay (so an
 * extension asking a question reaches the app instead of silently cancelling). Everything
 * else falls back to a no-op, and `theme` to `passthroughTheme`.
 *
 * Returns `any` because our overrides are structurally narrower than Pi's interface
 * (its dialog signatures carry TUI-only option types); the call sites already pass this
 * through `bindExtensions({ uiContext })` untyped.
 */
export function createUIContext(overrides: Record<string, unknown> = {}): any {
  const target: Record<string, unknown> = { ...NO_OP_UI, theme: passthroughTheme, ...overrides };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj) return Reflect.get(obj, prop, receiver);
      // `then` must stay undefined or an await on this object would treat it as a
      // thenable and hang; same for other well-known symbol-ish probes.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return unknownMember();
    },
    // Deliberately NO `has` trap. Trapping it to always-true would make `in` claim we
    // implement things we don't, which silently defeats capability checks of the shape
    // `if (!("x" in ui)) fallback()`. Leaving it honest means `in` reports what is really
    // implemented while `get` still guarantees a call never throws — the safe pairing.
  });
}

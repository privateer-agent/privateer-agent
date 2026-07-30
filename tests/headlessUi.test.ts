import test from "node:test";
import assert from "node:assert/strict";
import { createUIContext, passthroughTheme } from "../src/ext/headlessUi.ts";

// The bug this guards: Pi decides `ctx.hasUI` by identity against its private
// noOpUIContext, so binding ANY object flips hasUI true — and every extension that then
// guards on `ctx.hasUI` calls the FULL ExtensionUIContext surface. Our relay-driven
// callers only implemented select/confirm/input/notify, so pi-mcp-adapter's
// `ctx.ui.setStatus(...)` threw and aborted MCP init, silently stripping every connector's
// tools from the session. Observed live as: `MCP initialization failed: ui.setStatus is
// not a function`.

test("headless UI context: implements the methods extensions actually call", () => {
  const ui = createUIContext();

  // The exact call that broke MCP init in a harbor session.
  assert.doesNotThrow(() => ui.setStatus("mcp", "MCP: connecting to 2 servers..."));
  assert.doesNotThrow(() => ui.setStatus("mcp", undefined));
  // pi-mcp-adapter's status bar also colorizes through the theme.
  assert.doesNotThrow(() => ui.setStatus("mcp", ui.theme.fg("accent", "MCP: 2/2 servers")));

  // The rest of the presentational surface Pi's own no-op context covers.
  for (const m of [
    "notify", "onTerminalInput", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator",
    "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor",
    "setEditorText", "getEditorText", "addAutocompleteProvider", "setEditorComponent",
    "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded",
  ]) {
    assert.equal(typeof ui[m], "function", `${m} must exist — a missing one aborts extension init`);
    assert.doesNotThrow(() => ui[m]("k", "v"), `${m} must be safe to call headlessly`);
  }
});

test("headless UI context: caller's dialog implementations win over the no-ops", async () => {
  const asked: string[] = [];
  const ui = createUIContext({
    async select(title: string, options: string[]) { asked.push(title); return options[0]; },
    async confirm() { return true; },
    async input() { return "typed"; },
    notify(message: string) { asked.push(`notify:${message}`); },
  });

  assert.equal(await ui.select("Pick one", ["a", "b"]), "a", "the relay-backed select is used");
  assert.equal(await ui.confirm("Sure?", ""), true, "not the no-op default of false");
  assert.equal(await ui.input("Name?"), "typed");
  ui.notify("hello");
  assert.deepEqual(asked, ["Pick one", "notify:hello"]);
});

test("headless UI context: an unknown future Pi method degrades instead of throwing", () => {
  const ui = createUIContext();
  // Pi adds UI methods release to release. A missing one must cost a visual, not abort
  // the extension — that asymmetry is the whole reason for the Proxy backstop.
  assert.doesNotThrow(() => ui.setSomethingPiAddedLastWeek("x"), "unknown members are callable no-ops");
  assert.equal(ui.setSomethingPiAddedLastWeek("x"), undefined);
});

test("headless UI context: is not accidentally thenable", async () => {
  // The Proxy answers `get` for everything, so an unguarded `then` would make `await`
  // treat the context as a promise and hang forever. bindExtensions passes it through
  // async plumbing, so this is a live hazard, not a hypothetical.
  const ui = createUIContext();
  assert.equal(ui.then, undefined, "`then` must stay undefined");
  const settled = await Promise.resolve(ui);
  assert.equal(settled.getEditorText(), "", "awaiting it yields the context itself");
});

test("passthrough theme: returns text unstyled rather than injecting ANSI", () => {
  // Headless output lands in a log file or crosses the relay to the app's feed; escape
  // codes would be noise in the first and unwanted in the second.
  assert.equal(passthroughTheme.fg("accent", "MCP: 2/2 servers"), "MCP: 2/2 servers");
  assert.equal(passthroughTheme.bold("x"), "x");
  assert.equal(passthroughTheme.getFgAnsi(), "");
  assert.equal(passthroughTheme.getThinkingBorderColor()("border"), "border");
});

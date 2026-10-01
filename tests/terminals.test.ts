import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalBackend } from "../src/terminals/backends.ts";

// Named terminals (src/terminals/, the `terminal` tool, /term). The AppleScript itself
// can only be exercised on a Mac with a window server, so these tests pin everything
// around it: which backend a terminal gets, how names are kept and pruned, what the
// service refuses, the exact tmux calls, and how the gate classifies each action.

process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "privateer-terminals-"));

const { detectBackend, tmux, hangUp, shellLine, asString, ttyOf } = await import("../src/terminals/backends.ts");
const { checkName, freeName, readRegistry, registryPath, saveTerminal } = await import("../src/terminals/registry.ts");
const terminals = await import("../src/terminals/index.ts");
const { classifyToolCall } = await import("../src/permissions/classify.ts");
const { terminalToolDefinition } = await import("../src/tools/terminal.ts");

/** A window system in memory: ids are fake ttys, `self` is the window we run in. */
function fakeBackend(self = "/dev/ttys001") {
  const windows = new Set<string>([self]);
  const calls: string[] = [];
  let next = 10;
  const b: TerminalBackend = {
    app: "Apple_Terminal",
    label: "Terminal",
    async open(req) {
      const id = `/dev/ttys0${next++}`;
      windows.add(id);
      calls.push(`open ${req.name} ${req.cwd} ${req.command ?? ""} focus=${req.focus}`);
      return id;
    },
    async focus(id) {
      calls.push(`focus ${id}`);
      return windows.has(id);
    },
    async close(id) {
      calls.push(`close ${id}`);
      return windows.delete(id);
    },
    live: async () => new Set(windows),
    selfId: async () => self,
    isFront: async () => undefined,
  };
  return { b, windows, calls };
}

const fresh = () => rmSync(registryPath(), { force: true });

test("tmux wins whenever we are inside it; macOS apps by TERM_PROGRAM; anything else is told plainly", () => {
  assert.equal((detectBackend({ TMUX: "/tmp/tmux", TERM_PROGRAM: "Apple_Terminal" }, "darwin") as TerminalBackend).app, "tmux");
  assert.equal((detectBackend({ TERM_PROGRAM: "Apple_Terminal" }, "darwin") as TerminalBackend).app, "Apple_Terminal");
  assert.equal((detectBackend({ TERM_PROGRAM: "iTerm.app" }, "darwin") as TerminalBackend).app, "iTerm.app");
  const ghostty = detectBackend({ TERM_PROGRAM: "ghostty" }, "darwin");
  assert.ok("unsupported" in ghostty && /ghostty/.test(ghostty.unsupported) && /tmux/.test(ghostty.unsupported));
  assert.ok("unsupported" in detectBackend({}, "linux"));
});

test("names: trimmed, bounded, case-insensitive, and deduped with a suffix", () => {
  assert.deepEqual(checkName("  dev   server "), { name: "dev server" });
  assert.ok("error" in checkName(""));
  assert.ok("error" in checkName("a;rm -rf"));
  assert.ok("error" in checkName("x".repeat(41)));
  const taken = [{ name: "API", app: "tmux" as const, id: "%1", cwd: "/", createdAt: 0 }];
  assert.equal(freeName("api", taken), "api-2");
  assert.equal(freeName("web", taken), "web");
});

test("shell lines quote the folder, and AppleScript strings escape quotes and backslashes", () => {
  assert.equal(shellLine("/tmp/it's here", "npm run dev"), `cd '/tmp/it'\\''s here' && npm run dev`);
  assert.equal(shellLine("/tmp"), `cd '/tmp'`);
  assert.equal(asString(`say "hi" \\ there`), `"say \\"hi\\" \\\\ there"`);
});

test("open registers the window (and this one), focus switches by name, close ends it", async () => {
  fresh();
  const { b, windows, calls } = fakeBackend();
  terminals.setBackendForTests(b);

  const opened = await terminals.openTerminal({ name: "api", cwd: "/srv/app", command: "npm run dev" });
  assert.equal(opened.ok, true);
  const names = readRegistry().map((r) => r.name).sort();
  assert.deepEqual(names, ["api", "app"]); // "app" is this window, named after its folder

  assert.equal((await terminals.openTerminal({ name: "API", cwd: "/srv/app" })).ok, false, "names are unique, any case");

  assert.equal((await terminals.focusTerminal("Api", "/srv/app")).message, `Switched to "api".`);
  assert.equal((await terminals.focusTerminal("app", "/srv/app")).ok, true, "and back to where the agent runs");

  const listing = await terminals.terminalListing("/srv/app");
  assert.ok(!("unsupported" in listing));
  assert.match(terminals.describeListing(listing), /app: \/srv\/app {2}← this one/);
  assert.match(terminals.describeListing(listing), /api: \/srv\/app — npm run dev/);

  assert.equal((await terminals.closeTerminal("app", "/srv/app")).ok, false, "a window can't close itself");
  assert.equal((await terminals.closeTerminal("api", "/srv/app")).ok, true);
  assert.equal(windows.size, 1);
  assert.deepEqual(readRegistry().map((r) => r.name), ["app"]);
  assert.ok(calls.some((c) => c.startsWith("open api /srv/app npm run dev focus=true")));
});

test("open in the background puts focus back on this window", async () => {
  fresh();
  const { b, calls } = fakeBackend("/dev/ttys001");
  terminals.setBackendForTests(b);
  await terminals.openTerminal({ name: "logs", cwd: "/tmp", command: "tail -f x.log", focus: false });
  assert.equal(calls.at(-1), "focus /dev/ttys001");
});

test("windows that are gone are pruned before a name is trusted", async () => {
  fresh();
  const { b, windows } = fakeBackend();
  terminals.setBackendForTests(b);
  await terminals.openTerminal({ name: "tests", cwd: "/tmp" });
  const id = readRegistry().find((r) => r.name === "tests")!.id;
  windows.delete(id); // the user closed it by hand
  const r = await terminals.focusTerminal("tests", "/tmp");
  assert.equal(r.ok, false);
  assert.match(r.message, /No terminal named "tests"/);
  assert.equal(readRegistry().some((r) => r.name === "tests"), false);
});

test("a Privateer started in a window the agent opened keeps that window's name", async () => {
  fresh();
  saveTerminal({ name: "worker", app: "Apple_Terminal", id: "/dev/ttys042", cwd: "/x", createdAt: 1 });
  const { b, windows } = fakeBackend("/dev/ttys042");
  windows.add("/dev/ttys042");
  terminals.setBackendForTests(b);
  const self = await terminals.claimSelf(b, "/some/other/folder");
  assert.equal(self?.name, "worker");
  assert.equal((await terminals.renameSelf("builder", "/x")).ok, true);
  assert.deepEqual(readRegistry().map((r) => r.name), ["builder"]);
});

test("unsupported terminals get the reason, not an attempt", async () => {
  terminals.setBackendForTests({ unsupported: "Named terminals work inside tmux…" });
  const r = await terminals.openTerminal({ name: "x", cwd: "/tmp" });
  assert.deepEqual(r, { ok: false, message: "Named terminals work inside tmux…" });
});

test("tmux: pane ids, the command typed into a shell, -d for background", async () => {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === "new-window") return "%7\n";
    if (args[0] === "list-panes") return "%1\n%7\n";
    return "";
  };
  const t = tmux(exec, { TMUX_PANE: "%1" });
  assert.equal(await t.open({ name: "api", cwd: "/srv", command: "npm start", focus: false }), "%7");
  assert.deepEqual(calls[0], ["tmux", "new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "api", "-c", "/srv"]);
  assert.deepEqual(calls[1], ["tmux", "send-keys", "-t", "%7", "-l", "npm start"]);
  assert.deepEqual(calls[2], ["tmux", "send-keys", "-t", "%7", "Enter"]);
  assert.equal(await t.selfId(), "%1");
  assert.equal(await t.focus("%9"), false, "a pane that's gone isn't focused");
  assert.equal(await t.focus("%7"), true);
  assert.deepEqual([...(await t.live())], ["%1", "%7"]);
});

test("hang-up signals every process on the tty, never this one", async () => {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return file === "ps" ? `  101\n  ${process.pid}\n  202\n` : "";
  };
  await hangUp("/dev/ttys009", exec);
  assert.deepEqual(calls, [
    ["ps", "-t", "ttys009", "-o", "pid="],
    ["kill", "-HUP", "101"],
    ["kill", "-HUP", "202"],
  ]);
  assert.equal(await ttyOf(1, async () => "ttys003\n"), "/dev/ttys003");
  assert.equal(await ttyOf(1, async () => "??\n"), undefined);
});

test("gate: focus and list pass; open runs its command as bash; close is bash-kind", () => {
  const scope = { cwd: "/tmp" } as any;
  assert.equal(classifyToolCall("terminal", { action: "focus", name: "api" }, scope), null);
  assert.equal(classifyToolCall("terminal", { action: "list" }, scope), null);
  const open = classifyToolCall("terminal", { action: "open", name: "x", command: "rm -rf /" }, scope)!;
  assert.equal(open.kind, "bash");
  assert.equal(open.detail, "rm -rf /", "the command itself is what the danger list and allowlist see");
  const shell = classifyToolCall("terminal", { action: "open", name: "x" }, scope)!;
  assert.equal(shell.kind, "bash");
  assert.equal(classifyToolCall("terminal", { action: "close", name: "x" }, scope)!.kind, "bash");
});

test("the tool refuses without a UI and asks for a name where one is needed", async () => {
  const run = (params: any, ctx?: any) =>
    terminalToolDefinition.execute("t", params, undefined, undefined, ctx).then((r: any) => r.content[0].text);
  assert.match(await run({ action: "open", name: "x" }, { hasUI: false }), /interactive session/);
  assert.match(await run({ action: "focus" }, { hasUI: true }), /name is required/);
});

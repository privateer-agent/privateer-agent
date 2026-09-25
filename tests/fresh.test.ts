import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRESH_SOCKET_ENV,
  FRESH_TOKEN_ENV,
  collectTree,
  filterRespawnArgs,
  listTerminals,
  parsePs,
  requestFresh,
} from "../bin/fresh-supervisor.mjs";

// Fresh agent: the launcher swaps a terminal's agent for a new PROCESS and reaps the
// old tree (bin/fresh-supervisor.mjs). What has to hold:
//  - the reap reaches what Pi's bash tool started DETACHED, which is reparented to init
//    the moment the agent dies — so the tree must be read before anything is signalled;
//  - it never signals the supervisor's own process group (the terminal's foreground
//    group, which the supervisor itself is in);
//  - the new agent carries nothing that ties it to the old session or replays its task;
//  - only the holder of the per-launch token can ask.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, "..", "bin", "fresh-supervisor.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(check: () => boolean, ms = 10_000) {
  for (let i = 0; i < ms / 50 && !check(); i++) await sleep(50);
  return check();
}

// ── the tree ────────────────────────────────────────────────────────────────

test("parsePs reads ps output and skips junk", () => {
  assert.deepEqual(parsePs("  10     1    10\n 11 10 10\nPID PPID PGID\n\n"), [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
  ]);
});

test("collectTree: descendants, detached groups, and orphans still in those groups", () => {
  // 100 = supervisor, group 100 (the terminal's foreground group)
  // 200 = the TUI, same group
  // 300 = bash tool command, detached → leads group 300; 301 its child
  // 302 = a grandchild in group 300 whose parent already exited → ppid 1
  // 400 = a subagent, not detached → still in group 100
  // 900 = an unrelated process in the supervisor's group (the user's shell job)
  const rows = [
    { pid: 100, ppid: 50, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 100 },
    { pid: 300, ppid: 200, pgid: 300 },
    { pid: 301, ppid: 300, pgid: 300 },
    { pid: 302, ppid: 1, pgid: 300 },
    { pid: 400, ppid: 200, pgid: 100 },
    { pid: 900, ppid: 50, pgid: 100 },
  ];
  const { pids, groups } = collectTree(rows, 200, 100);
  assert.deepEqual([...pids].sort(), [200, 300, 301, 302, 400]);
  assert.deepEqual(groups, [300], "the supervisor's own group is never signalled as a group");
  assert.ok(!pids.includes(100) && !pids.includes(900), "never the supervisor or its neighbours");
});

// ── the args ────────────────────────────────────────────────────────────────

test("respawn drops what ties the new agent to the old one, keeps how it runs", () => {
  assert.deepEqual(
    filterRespawnArgs([
      "--continue", "--model", "tinfoil/gemma4-31b", "--session", "abc", "--no-quarter",
      "@notes.md", "--api-key", "sk-x", "fix the login test", "-n", "work", "--thinking", "high",
    ]),
    ["--model", "tinfoil/gemma4-31b", "--no-quarter", "--api-key", "sk-x", "--thinking", "high"],
  );
});

test("respawn follows Pi's arity rules for unknown flags and known booleans", () => {
  // An extension flag takes the next word as its value (Pi's rule), a known boolean
  // does not — so the word after --verbose is the old prompt and must go.
  assert.deepEqual(filterRespawnArgs(["--allow-computer-control", "--verbose", "do it"]), [
    "--allow-computer-control",
    "--verbose",
  ]);
  assert.deepEqual(filterRespawnArgs(["--budget", "5", "task"]), ["--budget", "5"]);
  assert.deepEqual(filterRespawnArgs(["-r", "--fork", "s1", "--session-id=x", "-c"]), ["--session-id=x"]);
  assert.deepEqual(filterRespawnArgs(["--model", "m", "--", "--model", "x"]), ["--model", "m"]);
});

// ── the supervisor, end to end ──────────────────────────────────────────────

test("fresh: the old agent and what it started detached are stopped, a new one starts", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-fresh-"));
  const home = path.join(dir, "home");
  // A stand-in TUI: records its generation and pid, and starts a DETACHED child the way
  // Pi's bash tool does, so the reap has to find it after its parent is gone.
  const tui = path.join(dir, "tui.mjs");
  fs.writeFileSync(tui, [
    `import fs from "node:fs";`,
    `import { spawn } from "node:child_process";`,
    `const gen = process.argv[2];`,
    `const bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
    `bg.unref();`,
    `fs.writeFileSync(${JSON.stringify(dir)} + "/tui-" + gen, JSON.stringify({ pid: process.pid, bg: bg.pid, env: !!process.env.${FRESH_TOKEN_ENV} }));`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));
  const harness = path.join(dir, "harness.mjs");
  fs.writeFileSync(harness, [
    `import { runSupervised } from ${JSON.stringify(SUPERVISOR)};`,
    `runSupervised(process.execPath, (first) => [${JSON.stringify(tui)}, first ? "1" : "2"], { home: ${JSON.stringify(home)} });`,
  ].join("\n"));
  const sup = spawn(process.execPath, [harness], { stdio: "ignore" });
  const read = (gen: string) => JSON.parse(fs.readFileSync(path.join(dir, `tui-${gen}`), "utf8"));
  const cleanup: number[] = [sup.pid!];

  try {
    assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "tui-1"))), "the first agent never started");
    const first = read("1");
    cleanup.push(first.pid, first.bg);
    assert.ok(first.env, "the agent is handed the socket + token");

    assert.ok(await waitFor(() => listTerminals(home).length === 1), "the terminal never registered");
    const [term] = listTerminals(home);
    assert.equal(term.pid, sup.pid);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(home, "run", `${sup.pid}.json`)).mode & 0o777, 0o600, "registry holds the token — owner-only");
    }

    await assert.rejects(requestFresh(term.socket, "not-the-token"), /bad token/);
    assert.ok(alive(first.pid), "a bad token changed nothing");

    await requestFresh(term.socket, term.token);
    assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "tui-2"))), "no fresh agent started");
    const second = read("2");
    cleanup.push(second.pid, second.bg);

    assert.ok(await waitFor(() => !alive(first.pid)), "the old agent is still running");
    assert.ok(await waitFor(() => !alive(first.bg)), "what the old agent started detached is still running — the orphan leak");
    assert.ok(alive(second.pid), "the new agent should be running");
    assert.ok(alive(sup.pid!), "the supervisor must survive the swap");
    assert.equal(listTerminals(home)[0]?.childPid, second.pid, "the registry points at the new agent");
  } finally {
    for (const pid of cleanup) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
});

// ── /fresh ──────────────────────────────────────────────────────────────────

test("/fresh sends the launcher's token, and takes it out of the agent's environment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-fresh-ext-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\pv-fresh-test-${process.pid}` : path.join(dir, "s.sock");
  const got: any[] = [];
  const server = net.createServer((c) => {
    c.on("data", (d) => {
      got.push(JSON.parse(String(d)));
      c.end(JSON.stringify({ ok: true, pid: 1 }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  process.env[FRESH_SOCKET_ENV] = sock;
  process.env[FRESH_TOKEN_ENV] = "t0ken";

  const { default: privateerFresh } = await import("../extensions/privateer-fresh.ts");
  const commands = new Map<string, any>();
  const notices: string[] = [];
  privateerFresh({ registerCommand: (n: string, o: any) => commands.set(n, o) });
  assert.equal(process.env[FRESH_TOKEN_ENV], undefined, "bash commands and subagents would inherit the key");
  assert.equal(process.env[FRESH_SOCKET_ENV], undefined);

  // A second load (what /reload does) still has the key.
  privateerFresh({ registerCommand: (n: string, o: any) => commands.set(n, o) });
  await commands.get("fresh").handler("", { ui: { notify: (m: string) => notices.push(m) } });
  server.close();
  assert.deepEqual(got, [{ op: "fresh", token: "t0ken" }]);
  assert.ok(!notices.some((n) => n.includes("Couldn't")), notices.join("\n"));
});

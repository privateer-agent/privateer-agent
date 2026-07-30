/**
 * The `context` frame — what a terminal tells a driving app about itself.
 *
 * The frame is deliberately thin (model / version / terminalPub): the relay hop is
 * the server, so anything machine-identifying that goes into it is something the
 * server learns. `cwd` is the one scoped addition, sent ONLY by a harbor-spawned
 * live session, where the driver either chose the folder or needs to see the one the
 * harbor chose for them — and even then it is home-collapsed so the OS username is
 * not what crosses the wire.
 *
 * These tests pin that shape on a fake socket: no relay, no server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "priv-relay-ctx-"));
process.env.PRIVATEER_HOME = HOME;

const { RelayClient } = await import("../src/remote/relayClient.ts");

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A RelayClient wired to a socket that just records what was sent. */
function relayWithSocket() {
  const sent: any[] = [];
  const relay: any = new RelayClient({} as any, { termId: "task-1", label: "Task" });
  relay.ws = {
    readyState: 1, // WebSocket.OPEN
    send(raw: string) { sent.push(JSON.parse(raw)); },
  };
  return { relay, sent };
}

test("context frame: omits cwd when the caller doesn't pass one", () => {
  const { relay, sent } = relayWithSocket();
  relay.sendContext({ model: "openrouter:z-ai/glm-5.2", version: "0.3.6" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "context");
  assert.equal(sent[0].model, "openrouter:z-ai/glm-5.2");
  assert.equal("cwd" in sent[0], false, "an interactive terminal must not leak a working directory");
});

test("context frame: a spawned session's cwd is sent home-collapsed", () => {
  const { relay, sent } = relayWithSocket();
  relay.sendContext({ model: "m", cwd: join(homedir(), "Documents", "tree"), version: "0.3.6" });

  assert.equal(sent[0].cwd, "~/Documents/tree");
  assert.equal(sent[0].cwd.includes(homedir()), false, "the absolute home path must not cross the relay");
});

test("context frame: a cwd outside home is sent as-is, and an empty one is dropped", () => {
  const { relay, sent } = relayWithSocket();
  relay.sendContext({ cwd: "/srv/agent/work" });
  relay.sendContext({ cwd: "" });

  assert.equal(sent[0].cwd, "/srv/agent/work");
  assert.equal("cwd" in sent[1], false);
});

test("context frame: a near-home path is not mistaken for home", () => {
  const { relay, sent } = relayWithSocket();
  // `${home}2` shares the prefix but is a different account's directory — collapsing
  // it would rewrite the path into one that doesn't exist.
  relay.sendContext({ cwd: `${homedir()}2/work` });

  assert.equal(sent[0].cwd, `${homedir()}2/work`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChannelsControl, CHANNEL_PLATFORMS } from "../src/remote/channelsControl.ts";
import { configPath } from "../src/config/paths.ts";

// Run `fn` with a throwaway PRIVATEER_HOME so channelsControl reads/writes an
// isolated config.json, restoring the env after.
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("channelsControl: list always returns all four platforms, unconfigured by default", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    const items = ctrl.list();
    assert.deepEqual(items.map((c) => c.platform), [...CHANNEL_PLATFORMS]);
    assert.ok(items.every((c) => !c.configured && !c.running));
    assert.ok(items.every((c) => c.adminCount === 0 && c.secretsSet.length === 0));
  });
});

test("channelsControl: save persists non-secret fields; list reflects them", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    const res = ctrl.save({ platform: "telegram", admins: ["111", "222"], posture: "auto", tools: ["read", "bash"], model: "openrouter/x" });
    assert.ok(res.ok, res.message);

    const tg = ctrl.list().find((c) => c.platform === "telegram")!;
    assert.ok(tg.configured);
    assert.equal(tg.adminCount, 2);
    assert.equal(tg.posture, "auto");
    assert.deepEqual(tg.tools, ["read", "bash"]);
    assert.equal(tg.model, "openrouter/x");
    assert.deepEqual(tg.secretsSet, []); // no token supplied yet
  });
});

test("channelsControl: fail-closed when a block has no admins and no members", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    // New platform, no roles at all → rejected, nothing persisted.
    assert.equal(ctrl.save({ platform: "slack", posture: "approve" }).ok, false);
    assert.ok(!ctrl.list().find((c) => c.platform === "slack")!.configured);
    // A members-only channel is allowed (chat-only, read-only users).
    assert.ok(ctrl.save({ platform: "slack", members: ["u1"] }).ok);
  });
});

test("channelsControl: secrets are stored and reported by NAME only, never echoed", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    ctrl.save({ platform: "telegram", admins: ["1"], secrets: { botToken: "s3cr3t-token" } });

    const tg = ctrl.list().find((c) => c.platform === "telegram")!;
    assert.deepEqual(tg.secretsSet, ["botToken"]); // presence by name
    // The projection carries no field whose value is the token.
    assert.ok(!Object.values(tg).some((v) => typeof v === "string" && v.includes("s3cr3t")));
    // The token IS written to config on the box (plaintext config is expected there).
    const raw = readFileSync(configPath(), "utf8");
    assert.ok(raw.includes("s3cr3t-token"));
  });
});

test("channelsControl: edit keeps existing roles/secrets when omitted, replaces when present", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    ctrl.save({ platform: "telegram", admins: ["a1", "a2"], secrets: { botToken: "tok1" }, posture: "approve" });

    // Edit posture only — admins + secret must survive.
    assert.ok(ctrl.save({ platform: "telegram", posture: "auto" }).ok);
    let tg = ctrl.list().find((c) => c.platform === "telegram")!;
    assert.equal(tg.adminCount, 2, "admins preserved when omitted");
    assert.deepEqual(tg.secretsSet, ["botToken"], "token preserved when omitted");
    assert.equal(tg.posture, "auto");

    // Replace admins explicitly.
    assert.ok(ctrl.save({ platform: "telegram", admins: ["only"] }).ok);
    tg = ctrl.list().find((c) => c.platform === "telegram")!;
    assert.equal(tg.adminCount, 1);

    // An empty (blank) secret value does NOT clobber the stored token.
    assert.ok(ctrl.save({ platform: "telegram", secrets: { botToken: "  " } }).ok);
    tg = ctrl.list().find((c) => c.platform === "telegram")!;
    assert.deepEqual(tg.secretsSet, ["botToken"]);
  });
});

test("channelsControl: remove deletes the block; second remove reports not-configured", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    ctrl.save({ platform: "discord", admins: ["1"] });
    assert.ok(ctrl.remove("discord").ok);
    assert.ok(!ctrl.list().find((c) => c.platform === "discord")!.configured);
    assert.equal(ctrl.remove("discord").ok, false);
  });
});

test("channelsControl: running reflects the injected heartbeat read", () => {
  withHome(() => {
    const live = new Set<string>(["telegram"]);
    const ctrl = makeChannelsControl({ runningPlatforms: () => live });
    ctrl.save({ platform: "telegram", admins: ["1"] });
    ctrl.save({ platform: "slack", members: ["u"] });
    const items = ctrl.list();
    assert.equal(items.find((c) => c.platform === "telegram")!.running, true);
    assert.equal(items.find((c) => c.platform === "slack")!.running, false);
  });
});

test("channelsControl: rejects an unknown platform and an invalid posture", () => {
  withHome(() => {
    const ctrl = makeChannelsControl({});
    assert.equal(ctrl.save({ platform: "carrier-pigeon" as any, admins: ["1"] }).ok, false);
    assert.equal(ctrl.save({ platform: "telegram", admins: ["1"], posture: "yolo" as any }).ok, false);
  });
});

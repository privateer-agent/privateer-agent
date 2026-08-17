import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pin is TOFU, and the whole value of TOFU is in its LIMITS: it can say the image
// changed, never that it was right. These tests hold the semantics to that — first
// sight is not a pass, drift is not a failure, and a restart of the same image is not
// drift (which is why instance-id is excluded).

/** Run a body with PRIVATEER_HOME pointed at a scratch dir, module state reset. */
async function withHome<T>(fn: (mod: typeof import("../src/providers/phala/pin.ts")) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pv-phala-pin-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = dir;
  try {
    // Fresh import per case: the module reads globalDir() lazily, but a cache-busting
    // query keeps any future module-level state from leaking between tests.
    const mod = await import(`../src/providers/phala/pin.ts?${dir}`);
    return await fn(mod);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const IMAGE = { mrTd: "aa".repeat(48), appId: "fdb7a14e", composeHash: "73fa4608", osImageHash: "bd369a8c" };
const AT = () => "2026-08-17T00:00:00.000Z";

test("first sight records the pin and reports first-seen, not verified", () => {
  return withHome(({ checkPin }) => {
    const res = checkPin(IMAGE, AT);
    assert.equal(res.state, "first-seen");
    assert.deepEqual(res.changed, []);
    assert.equal(res.firstSeenAt, AT());
  });
});

test("the same image on a later run reports unchanged", () => {
  return withHome(({ checkPin }) => {
    checkPin(IMAGE, AT);
    const res = checkPin(IMAGE, () => "2026-09-01T00:00:00.000Z");
    assert.equal(res.state, "unchanged");
    assert.equal(res.firstSeenAt, AT(), "first-seen time is preserved across runs");
  });
});

test("a changed image names exactly the fields that moved", () => {
  return withHome(({ checkPin }) => {
    checkPin(IMAGE, AT);
    const res = checkPin({ ...IMAGE, composeHash: "91bd0c2a", osImageHash: "ffffffff" }, AT);
    assert.equal(res.state, "changed");
    assert.equal(res.changed.length, 2);
    assert.ok(res.changed.some((c) => c.startsWith("composeHash:")));
    assert.ok(res.changed.some((c) => c.startsWith("osImageHash:")));
    assert.ok(!res.changed.some((c) => c.startsWith("mrTd:")), "unmoved fields are not reported");
  });
});

test("a change is reported ONCE, then becomes the new baseline", () => {
  return withHome(({ checkPin }) => {
    checkPin(IMAGE, AT);
    const next = { ...IMAGE, composeHash: "91bd0c2a" };
    assert.equal(checkPin(next, AT).state, "changed");
    // Repeating the warning every turn until it is wallpaper is how a real change gets
    // ignored — the user has already been shown what moved.
    assert.equal(checkPin(next, AT).state, "unchanged");
  });
});

test("a field the gateway stops sending is an absence, not drift", () => {
  return withHome(({ checkPin }) => {
    checkPin(IMAGE, AT);
    const res = checkPin({ mrTd: IMAGE.mrTd, appId: IMAGE.appId }, AT);
    assert.equal(res.state, "unchanged");
  });
});

test("instance-id is deliberately absent from the pinned set", () => {
  return withHome(async ({ checkPin }) => {
    checkPin(IMAGE, AT);
    // Restarting the same image mints a new instance-id. If it were pinned, every
    // restart would raise a false alarm and bury the one that matters.
    const stored = JSON.parse(readFileSync(join(process.env.PRIVATEER_HOME!, "phala-enclave-pin.json"), "utf8"));
    assert.ok(!("instanceId" in stored.pin));
  });
});

test("a corrupted pin file degrades to first-seen, not a crash or a false match", () => {
  return withHome(({ checkPin }) => {
    writeFileSync(join(process.env.PRIVATEER_HOME!, "phala-enclave-pin.json"), "{ not json", "utf8");
    assert.equal(checkPin(IMAGE, AT).state, "first-seen");
  });
});

test("a pin written by a future version is not trusted as a match", () => {
  return withHome(({ checkPin }) => {
    writeFileSync(
      join(process.env.PRIVATEER_HOME!, "phala-enclave-pin.json"),
      JSON.stringify({ v: 99, pin: { mrTd: "different" } }),
      "utf8",
    );
    assert.equal(checkPin(IMAGE, AT).state, "first-seen");
  });
});

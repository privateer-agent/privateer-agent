import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_PRIVATEER = "PRIVATEER_PRIVACY_OFF";
const ENV_PI = "PI_PRIVACY_OFF";

delete process.env[ENV_PRIVATEER];
delete process.env[ENV_PI];

const { onPrivacyDisabledChange, privacyDisabled, setPrivacyDisabled, togglePrivacyDisabled } = await import("../src/config/privacyDisabled.ts");

const COPY_SPECIFIER = "../src/config/privacyDisabled.ts?extension-copy";
const copy: typeof import("../src/config/privacyDisabled.ts") = await import(COPY_SPECIFIER);

test("privacy off without env flags is false", () => {
  delete process.env[ENV_PRIVATEER];
  delete process.env[ENV_PI];
  assert.equal(privacyDisabled(), false);
});

test("toggling mirrors the env, so subagents and other modules inherit the state", () => {
  try {
    assert.equal(togglePrivacyDisabled(), true);
    assert.equal(privacyDisabled(), true);
    assert.equal(process.env[ENV_PRIVATEER], "1");
    assert.equal(process.env[ENV_PI], "1");

    assert.equal(togglePrivacyDisabled(), false);
    assert.equal(privacyDisabled(), false);
    assert.equal(process.env[ENV_PRIVATEER], undefined);
    assert.equal(process.env[ENV_PI], undefined);
  } finally {
    setPrivacyDisabled(false);
  }
});

test("a second copy of the module sees the toggle (one state across jiti extension boundaries)", () => {
  assert.notEqual(copy.privacyDisabled, privacyDisabled, "the copies must really be distinct");
  try {
    setPrivacyDisabled(true);
    assert.equal(copy.privacyDisabled(), true, "extension copy must see privacy disabled");

    copy.setPrivacyDisabled(false);
    assert.equal(privacyDisabled(), false, "original copy must see privacy restored");
  } finally {
    setPrivacyDisabled(false);
  }
});

test("setting either PRIVATEER_PRIVACY_OFF or PI_PRIVACY_OFF disables privacy", () => {
  try {
    process.env[ENV_PRIVATEER] = "1";
    delete process.env[ENV_PI];
    assert.equal(privacyDisabled(), true);

    delete process.env[ENV_PRIVATEER];
    process.env[ENV_PI] = "1";
    assert.equal(privacyDisabled(), true);
  } finally {
    setPrivacyDisabled(false);
  }
});

// The flag is watchable because it now has TWO drivers — `/privacy` and the app's
// shield over the relay — and each has to be able to repaint what the other moved
// (the CLI's posture badge, the app's switch). A re-assert is not a move: firing on
// one would put "privacy filter off" in the feed on every reconnect.
test("watchers hear a real change, and only a real change", () => {
  const seen: boolean[] = [];
  const off = onPrivacyDisabledChange((v) => seen.push(v));
  try {
    setPrivacyDisabled(true);
    setPrivacyDisabled(true); // re-assert, not a change
    setPrivacyDisabled(false);
    assert.deepEqual(seen, [true, false]);

    off();
    setPrivacyDisabled(true);
    assert.deepEqual(seen, [true, false], "an unsubscribed watcher hears nothing");
  } finally {
    off();
    setPrivacyDisabled(false);
  }
});

// A watcher that throws must not leave the flag half-applied: the env var is the
// store, and the switch the operator pressed has to have taken effect regardless.
test("a throwing watcher cannot break the toggle", () => {
  const off = onPrivacyDisabledChange(() => { throw new Error("boom"); });
  try {
    setPrivacyDisabled(true);
    assert.equal(privacyDisabled(), true);
  } finally {
    off();
    setPrivacyDisabled(false);
  }
});

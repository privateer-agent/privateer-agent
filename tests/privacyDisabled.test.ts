import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_PRIVATEER = "PRIVATEER_PRIVACY_OFF";
const ENV_PI = "PI_PRIVACY_OFF";

delete process.env[ENV_PRIVATEER];
delete process.env[ENV_PI];

const { privacyDisabled, setPrivacyDisabled, togglePrivacyDisabled } = await import("../src/config/privacyDisabled.ts");

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

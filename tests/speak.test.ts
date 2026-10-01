import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spoken-responses wrapper (extensions/privateer-speak.ts). pi-speak's own
// behavior (toggle, distillation, cancellation, resolution order) is tested in its
// package; what THIS test pins is the wiring that lives here: the account provider
// lands in the shared registry with the confidential label and the signed-in
// preference, /speak registers, and the toggle persists into OUR home (speak.json
// under PRIVATEER_HOME), not ~/.pi.

const home = mkdtempSync(join(tmpdir(), "privateer-speak-"));
process.env.PRIVATEER_HOME = home;

const { default: privateerSpeak } = await import("../extensions/privateer-speak.ts");
const { getSpeechProvider, getTranscriptionProvider, resolveSpeechProvider, resolveTranscriptionProvider } =
  await import("privateer-speak");
const { hasCredentials } = await import("../src/auth/privateer.ts");
const { loadConfig } = await import("privateer-speak");

function load(command = "speak"): (args: string, ctx: any) => Promise<void> {
  let handler: any;
  privateerSpeak({
    on: () => {},
    registerCommand: (name: string, def: any) => {
      if (name === command) handler = def.handler;
    },
  });
  assert.ok(handler, `the extension no longer registers /${command}`);
  return handler;
}

test("the account provider is registered: confidential, described voices, signed-in availability", async () => {
  load();
  const p = getSpeechProvider("privateer");
  assert.ok(p, "no 'privateer' provider in the registry");
  assert.equal(p.privacy, "confidential");
  assert.equal(p.defaultVoice, "serena");
  const voices = (await p.voices!()) as Array<{ id: string; description?: string; language?: string; preview?: unknown }>;
  const vivian = voices.find((v) => v.id === "vivian");
  assert.ok(vivian, "vivian is offered");
  // Described in the app's (sourced) words, with the language Qwen publishes for her.
  if (!hasCredentials()) {
    assert.equal(vivian.description, "female · young · bright, edgy");
    assert.equal(vivian.language, "Chinese");
  }
  assert.equal(typeof vivian.preview, "function", "every account voice can be heard before picking it");
  assert.equal(p.attestedBy, "Privateer", "the shield names who attests the enclave");
  assert.ok(p.fetchSpeech, "account TTS must be fetchSpeech-style (bytes back, played locally)");
  // Availability and preference both track the live credential state, whatever it is
  // on this machine — the registry must never resolve to an unavailable account.
  assert.equal(p.available!(), hasCredentials());
  if (!hasCredentials()) assert.notEqual(resolveSpeechProvider()?.id, "privateer");
});

test("the account transcription provider is registered: confidential, signed-in availability", () => {
  load("talk");
  const p = getTranscriptionProvider("privateer");
  assert.ok(p, "no 'privateer' transcription provider in the registry");
  assert.equal(p.privacy, "confidential");
  assert.equal(p.available!(), hasCredentials());
  if (!hasCredentials()) assert.notEqual(resolveTranscriptionProvider()?.id, "privateer");
  // The badge says enclave, so the default asks for one by name rather than trusting
  // whatever the server's default happens to be.
  assert.equal(p.defaultModel!(), "tinfoil/whisper-large-v3-turbo");
  assert.equal(p.attestedBy, "Privateer");
});

test("/speak on persists into PRIVATEER_HOME/speak.json, off by default", async () => {
  const speak = load();
  const file = join(home, "speak.json");
  assert.notEqual(loadConfig(file).enabled, true);
  await speak("on", { ui: { notify: () => {} } });
  assert.equal(loadConfig(file).enabled, true);
  await speak("off", { ui: { notify: () => {} } });
  assert.equal(loadConfig(file).enabled, false);
});

test("voice languages come from the id or the maker's published table, never the name", async () => {
  const { voiceLanguage } = await import("../extensions/privateer-speak.ts");
  assert.equal(voiceLanguage("de_male"), "German");
  assert.equal(voiceLanguage("neutral_female"), "English");
  assert.equal(voiceLanguage("en_paul_sad"), "English");
  assert.equal(voiceLanguage("aura-2-fujin-ja"), "Japanese");
  assert.equal(voiceLanguage("af_heart"), "English (US)");
  assert.equal(voiceLanguage("ono_anna"), "Japanese");
  assert.equal(voiceLanguage("Zephyr"), undefined, "Google publishes no language for its voices");
});

test("the generated descriptions cover the account's default voices", async () => {
  const { VOICE_DESCRIPTIONS } = await import("../extensions/speak-voices.data.ts");
  for (const id of ["serena", "vivian", "ryan", "aiden", "eric"]) assert.ok(VOICE_DESCRIPTIONS[id], id);
  assert.equal(VOICE_DESCRIPTIONS.sohee, undefined, "Qwen publishes nothing for sohee, so neither do we");
});

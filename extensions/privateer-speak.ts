// Spoken responses AND voice input for the TUI: the generic privateer-speak (pi-speak)
// extension, plus Privateer's own providers hooked into both its registries — the
// account's confidential-compute TTS (/api/audio/speech, same path as the app's Audio
// studio and generate_speech; today Tinfoil qwen3-tts in an attested enclave) and its
// confidential STT (/api/audio/transcribe, same tinfoil/near routing the app's voice
// features use). Both inherit the account's entitlement, caps and billing.
//
// PROVIDER ATTUNEMENT, NOT STOMPING. The provider registers with preferWhen: signed-in,
// which the registry ranks ABOVE the built-in local voice but BELOW a deliberate /speak
// provider pick — sign in and speech quietly upgrades from the OS voice to confidential
// TTS, exactly the resolveSignedInModel pattern, with the model-persistence lesson
// applied (a user who picked "local" stays on "local").
//
// HONEST FRAMING. "Confidential", never "private end-to-end": the utterance text leaves
// the machine for the attested TTS enclave. That is the claim the label makes and the
// only one it may make. And this only ever speaks in interactive UI sessions — pi-speak
// gates on hasUI, so harbor/daemon/ACP surfaces stay silent by design (this extension is
// manifest-only, like privateer-hints: buildMoat never includes it).
//
// VOICES. qwen3-tts speakers, mirrored from the server's TINFOIL_VOICES (the list is
// static there too; first entry is the server-side default). Tinfoil requires the voice
// param server-side, so the server applies "serena" when none is sent — leaving voice
// unset here is always safe. If the account's default TTS model ever changes, update
// this list with it.
import { join } from "node:path";
import { makePiSpeakExtension, registerSpeechProvider, registerTranscriptionProvider } from "privateer-speak";
import { apiRequest, hasCredentials } from "../src/auth/privateer.ts";
import { globalDir } from "../src/config/paths.ts";

const QWEN3_TTS_VOICES = ["serena", "aiden", "dylan", "eric", "ono_anna", "ryan", "sohee", "uncle_fu", "vivian"];

// Call an account audio endpoint and hand back the parsed JSON, throwing the server's
// own (person-readable, localized) message on failure — same policy as media.ts's
// callAccount: surface, never swallow.
async function accountJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await apiRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw new Error(`could not reach Privateer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let message = `Privateer returned ${res.status}`;
    try {
      const err = (await res.json()) as { message?: string; error?: { message?: string } };
      message = err?.message ?? err?.error?.message ?? message;
    } catch {
      /* non-JSON body — the status message stands */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

registerSpeechProvider(
  {
    id: "privateer",
    label: "Privateer account TTS (attested enclave)",
    privacy: "confidential",
    defaultVoice: QWEN3_TTS_VOICES[0],
    voices: () => QWEN3_TTS_VOICES,
    available: () => hasCredentials(),
    fetchSpeech: async (text, { voice, signal }) => {
      const { audioBase64 } = await accountJson<{ audioBase64?: string }>(
        "/api/audio/speech",
        { text, ...(voice ? { voice } : {}) },
        signal,
      );
      if (!audioBase64) throw new Error("Privateer returned no audio");
      return { data: Buffer.from(audioBase64, "base64"), format: "mp3" };
    },
  },
  { preferWhen: () => hasCredentials() },
);

registerTranscriptionProvider(
  {
    id: "privateer",
    label: "Privateer account STT (attested enclave)",
    privacy: "confidential",
    available: () => hasCredentials(),
    transcribe: async (audio, { language, signal }) => {
      const { text } = await accountJson<{ text?: string }>(
        "/api/audio/transcribe",
        {
          audioBase64: Buffer.from(audio.data).toString("base64"),
          format: audio.format,
          ...(language ? { language } : {}),
        },
        signal,
      );
      return typeof text === "string" ? text : "";
    },
  },
  { preferWhen: () => hasCredentials() },
);

export default function privateerSpeak(pi: any): void {
  // Ours, beside config.json — NOT ~/.pi/speak.json, so a user who also runs plain Pi
  // with the generic package keeps two independent setups instead of a fought-over
  // file. globalDir() is read here, not at module load, so PRIVATEER_HOME set around
  // session creation (tests, the daemon) is honoured.
  makePiSpeakExtension({ configFile: join(globalDir(), "speak.json") })(pi);
}

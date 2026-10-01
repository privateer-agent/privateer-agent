// Spoken responses AND voice input for the TUI: the generic privateer-speak (pi-speak)
// extension, plus Privateer's own providers hooked into both its registries — the
// account's confidential-compute TTS (/api/audio/speech, same path as the app's Audio
// studio and generate_speech; today Tinfoil qwen3-tts in an attested enclave) and its
// confidential STT (/api/audio/transcribe, same tinfoil/near routing the app's voice
// features use). Both inherit the account's entitlement, caps and billing.
//
// STREAMING, AND WHAT IT COSTS. Since pi-speak 0.2.0 a turn is spoken while it is still
// being written: the stream is cut at sentence boundaries and each piece is synthesized
// a clip or two ahead of playback. For this provider that means SEVERAL /api/audio/speech
// calls per answer instead of one — same characters, same billing basis, more round
// trips — which is the trade that makes the reply start in about the time one sentence
// takes to speak. /speak stream off puts it back to one call at the end of the turn.
//
// NOT WIRED, DELIBERATELY. pi-speak passes two hints this account path has nowhere to
// put: `rate` (0.5–3× pace) and the transcriber's vocabulary `prompt`. /api/audio/speech
// takes { text, voice, format, ttsModelId } and /api/audio/transcribe takes
// { audioBase64, format, language, sttModelId } — neither has a speed or bias field — so
// sending them would be dead weight on the wire (and, for the vocabulary hint, project
// nouns leaving the machine to be ignored). They stay unsent until the endpoints grow
// them; both work today on the local and openai-compatible providers.
//
// PROVIDER ATTUNEMENT, NOT STOMPING. The provider registers with preferWhen: signed-in,
// which the registry ranks ABOVE the built-in local voice but BELOW a deliberate /speak
// provider pick — sign in and speech quietly upgrades from the OS voice to confidential
// TTS, exactly the resolveSignedInModel pattern, with the model-persistence lesson
// applied (a user who picked "local" stays on "local").
//
// HONEST FRAMING. "Confidential", never "fully private": the utterance text leaves
// the machine for the attested TTS enclave. That is the claim the label makes and the
// only one it may make. And this only ever speaks in interactive UI sessions — pi-speak
// gates on hasUI, so harbor/daemon/ACP surfaces stay silent by design (this extension is
// manifest-only, like privateer-hints: buildMoat never includes it).
//
// VOICES. Every TTS model the account can reach, each with the voices it really offers,
// comes from GET /api/agent/media/capabilities: its `speech.catalog` lists the models
// (name, provider, confidential or not, blocked by the account's ZDR setting or not),
// and `?ttsModel=<id>` returns one model's exact voice ids. Models blocked by the
// account's privacy setting are left out rather than offered to fail. Each voice is
// described in the app's words (speak-voices.data.ts, generated from the app's sourced
// table) and can be heard through /api/audio/voice-preview, which serves a fixed
// sentence from a cache shared across accounts: after the first listen, free.
//
// The account default (qwen3-tts, confidential) stays the default: a voice on it saves
// no model, so a change of default on the server carries users along. Picking a voice
// on another model saves that model, and it's sent as ttsModelId.
//
// Signed out, or the catalog unreachable: the qwen3-tts speakers below, so the picker
// is never empty. Tinfoil requires a voice server-side and applies "serena" when none is
// sent, so leaving voice unset is always safe.
import { join } from "node:path";
import {
  kokoroVoice,
  languageName,
  makePiSpeakExtension,
  registerSpeechProvider,
  registerTranscriptionProvider,
  type SpeechAudio,
  type TranscriptionModelInfo,
  type VoiceInfo,
} from "privateer-speak";
import { apiRequest, hasCredentials } from "../src/auth/privateer.ts";
import { globalDir } from "../src/config/paths.ts";
import { VOICE_DESCRIPTIONS } from "./speak-voices.data.ts";

const QWEN3_TTS_VOICES = ["serena", "aiden", "dylan", "eric", "ono_anna", "ryan", "sohee", "uncle_fu", "vivian"];
const DEFAULT_MODEL = "qwen3-tts";

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

// ── the voice catalog ───────────────────────────────────────────────────────

/**
 * The language a voice speaks, when its id or its maker says so. Same rules as the
 * app's voiceLabels.ts: Voxtral's `de_male` / `en_paul_sad`, Aura-2's trailing code,
 * MAI's leading tag, Kokoro's first letter, and Qwen's published native languages.
 */
const VOXTRAL_LANGUAGES = new Set(["ar", "de", "es", "fr", "hi", "it", "nl", "pt"]);
const ENGLISH_STYLES = new Set(["neutral", "casual", "cheerful", "american", "british"]);
const KOKORO_LANGUAGES: Record<string, string> = { a: "en-US", b: "en-GB", e: "es", f: "fr", h: "hi", i: "it", j: "ja", p: "pt-BR", z: "zh" };
const QWEN_NATIVE: Record<string, string> = {
  serena: "zh", vivian: "zh", uncle_fu: "zh", dylan: "zh", eric: "zh", ryan: "en", aiden: "en", ono_anna: "ja", sohee: "ko",
};

export function voiceLanguage(id: string): string | undefined {
  const two = /^([a-z]+)_(female|male)$/.exec(id);
  if (two) {
    if (VOXTRAL_LANGUAGES.has(two[1]!)) return languageName(two[1]!);
    if (ENGLISH_STYLES.has(two[1]!)) return "English";
  }
  const kokoro = /^([abefhijpz])[fm]_/.exec(id);
  if (kokoro) return languageName(KOKORO_LANGUAGES[kokoro[1]!]!);
  const styled = /^([a-z]{2})_[a-z]+_[a-z]+$/.exec(id);
  if (styled && (styled[1] === "en" || VOXTRAL_LANGUAGES.has(styled[1]!))) return languageName(styled[1]!);
  const aura = /^(?:aura-2|flux)-.+-([a-z]{2})$/.exec(id);
  if (aura) return languageName(aura[1]!);
  const mai = /^([a-z]{2}-[A-Z]{2})-[^:]+:/.exec(id);
  if (mai) return languageName(mai[1]!);
  return QWEN_NATIVE[id] ? languageName(QWEN_NATIVE[id]!) : undefined;
}

/** A readable name for ids that are really slugs: "aura-2-thalia-en" → "Thalia". */
function displayName(id: string): string | undefined {
  const aura = /^(?:aura-2|flux)-(.+)-[a-z]{2}$/.exec(id);
  if (aura) return aura[1]!.charAt(0).toUpperCase() + aura[1]!.slice(1);
  const mai = /^[a-z]{2}-[A-Z]{2}-([^:]+):/.exec(id);
  return mai?.[1];
}

interface CatalogModel {
  id: string;
  name?: string;
  provider?: string;
  isZdr?: boolean;
  isTee?: boolean;
  blockedByZdr?: boolean;
  voiceCount?: number;
}
interface SpeechCapabilities {
  speech?: { model?: string; voices?: string[]; catalog?: CatalogModel[] };
}

const CLIP_FORMATS: Record<string, SpeechAudio["format"]> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
};

/** A voice as the picker shows it: described, with its language, model and a sample. */
function voiceInfo(id: string, model: CatalogModel | undefined, modelId: string): VoiceInfo {
  // Kokoro's id states name and gender outright; the app's table adds the author's grade.
  const kokoro = /^[abefhijpz][fm]_/.test(id) ? kokoroVoice(id, modelId) : undefined;
  const description = kokoro?.description ?? VOICE_DESCRIPTIONS[id];
  const language = voiceLanguage(id);
  const name = kokoro?.name ?? displayName(id);
  return {
    id,
    model: modelId,
    ...(model?.name ? { modelName: model.name } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    // The enclave is attested by Privateer's server, which then forwards the text: the
    // shield says so ("TEE · attested by Privateer"), not that this terminal checked it.
    ...(model
      ? model.isTee
        ? { privacy: "confidential" as const, attestedBy: "Privateer" }
        : { privacy: model.isZdr ? ("zdr" as const) : ("standard" as const) }
      : {}),
    preview: async (signal?: AbortSignal): Promise<SpeechAudio> => {
      const { audioBase64, mimeType } = await accountJson<{ audioBase64?: string; mimeType?: string }>(
        "/api/audio/voice-preview",
        { ttsModelId: modelId, voice: id, locale: "en" },
        signal,
      );
      if (!audioBase64) throw new Error("Privateer returned no sample");
      return { data: Buffer.from(audioBase64, "base64"), format: CLIP_FORMATS[mimeType ?? ""] ?? "mp3" };
    },
  };
}

async function capabilities(ttsModel?: string): Promise<SpeechCapabilities> {
  const res = await apiRequest(`/api/agent/media/capabilities${ttsModel ? `?ttsModel=${encodeURIComponent(ttsModel)}` : ""}`, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Privateer returned ${res.status}`);
  return (await res.json()) as SpeechCapabilities;
}

// Read once per session: the catalog changes on deploys, not between keypresses.
let catalog: Promise<VoiceInfo[]> | undefined;
let accountDefault: string | undefined;

function loadCatalog(): Promise<VoiceInfo[]> {
  return (catalog ??= (async () => {
    const top = await capabilities();
    accountDefault = top.speech?.model;
    const models = (top.speech?.catalog ?? []).filter((m) => !m.blockedByZdr);
    // The default model first, then the rest as the server sorts them.
    models.sort((a, b) => Number(b.id === accountDefault) - Number(a.id === accountDefault));
    const lists = await Promise.all(
      models.map(async (m) => {
        const ids = m.id === accountDefault ? (top.speech?.voices ?? []) : m.voiceCount ? ((await capabilities(m.id).catch(() => ({}))) as SpeechCapabilities).speech?.voices ?? [] : [];
        // A model whose voices are prose, not a list: its default voice is still usable.
        return ids.length ? ids.map((id) => voiceInfo(id, m, m.id)) : [{ ...voiceInfo("", m, m.id), name: "default voice", preview: undefined }];
      }),
    );
    return lists.flat();
  })().catch((e) => {
    catalog = undefined; // try again next time the picker opens
    throw e;
  }));
}

const fallbackVoices = (): VoiceInfo[] =>
  QWEN3_TTS_VOICES.map((id) => ({
    ...voiceInfo(id, undefined, DEFAULT_MODEL),
    modelName: "Qwen3 TTS",
    privacy: "confidential" as const,
    attestedBy: "Privateer",
  }));

registerSpeechProvider(
  {
    id: "privateer",
    label: "Privateer",
    privacy: "confidential",
    attestedBy: "Privateer",
    defaultVoice: QWEN3_TTS_VOICES[0],
    model: () => accountDefault ?? DEFAULT_MODEL,
    voices: async () => {
      if (!hasCredentials()) return fallbackVoices();
      try {
        const voices = await loadCatalog();
        return voices.length ? voices : fallbackVoices();
      } catch {
        return fallbackVoices();
      }
    },
    available: () => hasCredentials(),
    fetchSpeech: async (text, { voice, model, signal }) => {
      const { audioBase64 } = await accountJson<{ audioBase64?: string }>(
        "/api/audio/speech",
        { text, ...(voice ? { voice } : {}), ...(model ? { ttsModelId: model } : {}) },
        signal,
      );
      if (!audioBase64) throw new Error("Privateer returned no audio");
      return { data: Buffer.from(audioBase64, "base64"), format: "mp3" };
    },
  },
  { preferWhen: () => hasCredentials() },
);

// ── transcription models ────────────────────────────────────────────────────
//
// The account's STT catalog is GET /api/models/openrouter?action=stt: OpenRouter's
// ZDR-covered transcription models plus the NEAR AI and Tinfoil enclave ones, each with
// isTee / isZdr. A model id goes back as sttModelId.
//
// THE DEFAULT IS ASKED FOR BY NAME. The server's own default (DEFAULT_STT_MODEL) is a
// deployment setting and today an OpenRouter ZDR model, not an enclave, so sending no
// model would let this provider's "confidential" badge describe something it doesn't
// control. Unless you pick otherwise, transcription asks for Tinfoil's enclave Whisper.
const CONFIDENTIAL_STT = "tinfoil/whisper-large-v3-turbo";

interface SttCatalogModel {
  id: string;
  name?: string;
  description?: string;
  isTee?: boolean;
  isZdr?: boolean;
}

/** The catalog's first sentence, short enough for a row. */
function oneLine(text: string | undefined): string | undefined {
  const first = text?.split(/(?<=\.)\s/)[0]?.trim().replace(/\.$/, "");
  if (!first) return undefined;
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

let sttCatalog: Promise<TranscriptionModelInfo[]> | undefined;
function loadSttCatalog(): Promise<TranscriptionModelInfo[]> {
  return (sttCatalog ??= (async () => {
    const res = await apiRequest("/api/models/openrouter?action=stt", { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Privateer returned ${res.status}`);
    const { models = [] } = (await res.json()) as { models?: SttCatalogModel[] };
    const described = models.map((m): TranscriptionModelInfo => {
      const about = oneLine(m.description);
      return {
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(about ? { description: about } : {}),
        ...(m.isTee
          ? { privacy: "confidential" as const, attestedBy: "Privateer" }
          : { privacy: m.isZdr ? ("zdr" as const) : ("standard" as const) }),
      };
    });
    // Enclave models first: they're what the default is and what the badge promises.
    return described.sort((a, b) => Number(b.privacy === "confidential") - Number(a.privacy === "confidential"));
  })().catch((e) => {
    sttCatalog = undefined;
    throw e;
  }));
}

registerTranscriptionProvider(
  {
    id: "privateer",
    label: "Privateer",
    privacy: "confidential",
    attestedBy: "Privateer",
    defaultModel: () => CONFIDENTIAL_STT,
    models: async () => {
      const fallback: TranscriptionModelInfo[] = [
        { id: CONFIDENTIAL_STT, name: "Whisper Large v3 Turbo", privacy: "confidential", attestedBy: "Privateer" },
      ];
      if (!hasCredentials()) return fallback;
      try {
        const models = await loadSttCatalog();
        return models.length ? models : fallback;
      } catch {
        return fallback;
      }
    },
    available: () => hasCredentials(),
    transcribe: async (audio, { language, model, signal }) => {
      const { text } = await accountJson<{ text?: string }>(
        "/api/audio/transcribe",
        {
          audioBase64: Buffer.from(audio.data).toString("base64"),
          format: audio.format,
          sttModelId: model ?? CONFIDENTIAL_STT,
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
  //
  // voiceCommands: saying one of these AS THE WHOLE UTTERANCE runs /fresh (see
  // extensions/privateer-fresh.ts) instead of sending the words to the model. Whole
  // utterance only, so "why did the fresh start fail" is still a question.
  makePiSpeakExtension({ configFile: join(globalDir(), "speak.json"), voiceCommands: VOICE_COMMANDS })(pi);
}

const VOICE_COMMANDS: Record<string, string> = {
  "fresh start": "/fresh",
  "start fresh": "/fresh",
  "fresh agent": "/fresh",
  "new agent": "/fresh",
};

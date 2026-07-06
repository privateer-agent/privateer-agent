import type { ProviderConfig, ProviderName } from "../config/schema.ts";
import { MINIMAX_BASE_URL, NEARAI_BASE_URL, QWEN_BASE_URL, TINFOIL_BASE_URL, VENICE_BASE_URL, ZAI_BASE_URL } from "./registry.ts";
import { authedFetch, serverBaseUrl, DEFAULT_SERVER_URL } from "../auth/privateer.ts";

// A model offered by a provider, as surfaced in the picker. `id` is the bare model
// id (no "provider:" prefix); `label` is an optional human-friendly name.
// `inputModalities` (when the provider reports it) lists accepted input kinds —
// e.g. ["text", "image"] — and lets the router know a model can actually see images.
export interface ModelInfo {
  id: string;
  label?: string;
  inputModalities?: string[];
}

const TIMEOUT_MS = 12_000;

// Default API roots per provider. These mirror each SDK's default so the listing
// endpoint and the actual chat endpoint stay in sync when no baseURL is configured.
const DEFAULT_BASE: Record<ProviderName, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  zai: ZAI_BASE_URL,
  moonshot: "https://api.moonshot.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  deepseek: "https://api.deepseek.com",
  minimax: MINIMAX_BASE_URL,
  qwen: QWEN_BASE_URL,
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/api",
  nearai: NEARAI_BASE_URL,
  tinfoil: TINFOIL_BASE_URL,
  venice: VENICE_BASE_URL,
  custom: "", // no default exists for a user-supplied endpoint; listModels requires cfg.baseURL
  privateer: DEFAULT_SERVER_URL, // unused by the privateer branch (authed endpoint), kept for type completeness
};

function baseFor(name: ProviderName, cfg: ProviderConfig): string {
  return (cfg.baseURL ?? DEFAULT_BASE[name]).replace(/\/+$/, "");
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = body.slice(0, 200).trim();
      throw new Error(`HTTP ${res.status} ${res.statusText}${hint ? ` — ${hint}` : ""}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Pull the list of models a provider currently offers, using the credentials the user
// supplied. Each provider exposes a different listing endpoint and response shape, so
// this is the second provider-specific seam (alongside the model factory in registry.ts).
// Throws with a readable message on auth/network failure so the picker can surface it.
export async function listModels(name: ProviderName, cfg: ProviderConfig): Promise<ModelInfo[]> {
  const base = baseFor(name, cfg);
  switch (name) {
    case "anthropic": {
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/v1/models?limit=1000`, {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      })) as { data?: { id: string; display_name?: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id, label: m.display_name }));
    }
    case "openai": {
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/models`, {
        authorization: `Bearer ${cfg.apiKey}`,
      })) as { data?: { id: string }[] };
      // Keep chat-capable families; the listing also includes embeddings/tts/whisper.
      const chat = (json.data ?? []).filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id));
      return (chat.length ? chat : (json.data ?? []))
        .map((m) => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "google": {
      // Gemini's native listing: names come prefixed ("models/gemini-…") and the list
      // includes embedding/TTS models, so keep only those that can generateContent.
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/models?pageSize=1000`, {
        "x-goog-api-key": cfg.apiKey,
      })) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      };
      return (json.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
        .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "xai":
    case "groq":
    case "zai":
    case "moonshot":
    case "cerebras":
    case "deepseek":
    case "minimax":
    case "qwen": {
      // These all speak the OpenAI listing shape.
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/models`, {
        authorization: `Bearer ${cfg.apiKey}`,
      })) as { data?: { id: string }[] };
      return (json.data ?? [])
        .map((m) => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "mistral": {
      // OpenAI listing shape plus a `capabilities` object: keep chat-capable models
      // (the list also carries embed/moderation/OCR entries) and surface the vision
      // flag as an image modality so the router knows which models can see.
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/models`, {
        authorization: `Bearer ${cfg.apiKey}`,
      })) as {
        data?: { id: string; capabilities?: { completion_chat?: boolean; vision?: boolean } }[];
      };
      return (json.data ?? [])
        .filter((m) => m.capabilities?.completion_chat ?? true)
        .map((m) => ({
          id: m.id,
          inputModalities: m.capabilities?.vision ? ["text", "image"] : undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "openrouter": {
      // OpenRouter's model list is public; the key is sent when present but optional.
      const json = (await getJson(
        `${base}/models`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      )) as {
        data?: { id: string; name?: string; architecture?: { input_modalities?: string[] } }[];
      };
      return (json.data ?? [])
        .map((m) => ({ id: m.id, label: m.name, inputModalities: m.architecture?.input_modalities }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "ollama": {
      // Locally installed models, via the Ollama daemon's tags endpoint.
      const json = (await getJson(`${base}/tags`, {})) as {
        models?: { name: string }[];
      };
      return (json.models ?? []).map((m) => ({ id: m.name }));
    }
    case "nearai": {
      // OpenAI-compatible model list. Every NEAR model runs in a TEE, so there's
      // no per-model capability to surface here beyond the id itself.
      if (!cfg.apiKey) throw new Error("no API key");
      const json = (await getJson(`${base}/models`, {
        authorization: `Bearer ${cfg.apiKey}`,
      })) as { data?: { id: string }[] };
      return (json.data ?? [])
        .map((m) => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "tinfoil": {
      // OpenAI listing shape plus Tinfoil extras: `type` separates chat models from
      // embeddings/TTS/whisper (keep chat only), and `multimodal` marks models that
      // can see — surfaced as an image modality so the router knows. The listing
      // itself is public; the key is sent when present.
      const json = (await getJson(
        `${base}/models`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      )) as { data?: { id: string; type?: string; multimodal?: boolean }[] };
      return (json.data ?? [])
        .filter((m) => (m.type ?? "chat") === "chat")
        .map((m) => ({ id: m.id, inputModalities: m.multimodal ? ["text", "image"] : undefined }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "venice": {
      // Venice's listing is public (the key is sent when present) and metadata-
      // rich. Each model declares a privacy tier: "private" (Venice-hosted, zero
      // retention by policy) vs "anonymized" (proxied to an upstream provider
      // that does see the prompt) — the latter is flagged in the label so the
      // picker stays honest.
      const json = (await getJson(
        `${base}/models?type=text`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      )) as {
        data?: {
          id: string;
          model_spec?: {
            name?: string;
            privacy?: string;
            capabilities?: { supportsVision?: boolean };
          };
        }[];
      };
      return (json.data ?? [])
        .map((m) => ({
          id: m.id,
          label:
            m.model_spec?.privacy === "anonymized"
              ? `${m.model_spec?.name ?? m.id} (anonymized — proxied upstream)`
              : m.model_spec?.name,
          inputModalities: m.model_spec?.capabilities?.supportsVision ? ["text", "image"] : undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "custom": {
      // User-supplied OpenAI-compatible endpoint: standard /models listing, key
      // optional (sent when present). No family filtering — we can't know what a
      // custom server hosts, so everything it reports is offered.
      if (!cfg.baseURL) throw new Error("no base URL — run /keys to set one");
      const json = (await getJson(
        `${base}/models`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      )) as { data?: { id: string }[] };
      return (json.data ?? [])
        .map((m) => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "privateer": {
      // The server proxies OpenRouter and bills to the account; list what the
      // account can use via the authed models endpoint (the JWT is injected by
      // authedFetch — no API key ever touches the client).
      const res = await authedFetch(`${serverBaseUrl()}/api/models/openrouter`);
      if (!res.ok) throw new Error(`HTTP ${res.status} listing account models`);
      const json = (await res.json()) as {
        models?: { id: string; name?: string; inputModalities?: string[]; architecture?: { input_modalities?: string[] } }[];
      };
      return (json.models ?? [])
        .map((m) => ({ id: m.id, label: m.name, inputModalities: m.inputModalities ?? m.architecture?.input_modalities }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
  }
}

// ── OpenRouter Zero-Data-Retention (ZDR) posture ─────────────────────────────
// OpenRouter exposes a model's retention story through two authenticated REST
// endpoints (both need the user's API key). We fold them into a per-account
// snapshot that the status-bar shield reads against the selected model.

export type ZdrPosture = "green" | "yellow" | "red";

export interface ZdrAccountData {
  // Models with at least one zero-data-retention endpoint (from /endpoints/zdr).
  zdrModelIds: Set<string>;
  // Models usable under the account's privacy settings + guardrails (from /models/user).
  userModelIds: Set<string>;
}

// Model ids may carry a variant suffix (":free", ":thinking") that the ZDR/user
// listings don't use on their permaslug. Strip it and lowercase so the sets,
// and the lookup against them, compare on the same canonical id.
function normalizeModelId(id: string): string {
  const i = id.indexOf(":");
  return (i === -1 ? id : id.slice(0, i)).trim().toLowerCase();
}

// Fetch the account's ZDR snapshot. Issues the two authed calls concurrently and
// reuses getJson's timeout + readable error message. Throws "no API key" (matching
// listModels) when no key is configured, since both endpoints require auth.
export async function fetchZdrAccount(cfg: ProviderConfig): Promise<ZdrAccountData> {
  if (!cfg.apiKey) throw new Error("no API key");
  const base = baseFor("openrouter", cfg);
  const headers = { authorization: `Bearer ${cfg.apiKey}` };
  const [zdr, user] = await Promise.all([
    getJson(`${base}/endpoints/zdr`, headers) as Promise<{ data?: { model_id?: string }[] }>,
    getJson(`${base}/models/user`, headers) as Promise<{ data?: { id?: string }[] }>,
  ]);
  const zdrModelIds = new Set(
    (zdr.data ?? []).flatMap((e) => (e.model_id ? [normalizeModelId(e.model_id)] : [])),
  );
  const userModelIds = new Set(
    (user.data ?? []).flatMap((m) => (m.id ? [normalizeModelId(m.id)] : [])),
  );
  return { zdrModelIds, userModelIds };
}

// Decide the shield color for a model against an account snapshot. Pure/synchronous
// so model switches re-evaluate without a network round-trip. `enforced` is the
// client's own ZDR-enforcement setting (config.providers.openrouter.enforceZdr):
// when on, Privateer pins requests to ZDR endpoints, so a ZDR-capable model is
// guaranteed zero-retention (green) rather than merely able to be (yellow).
export function zdrPosture(modelId: string, acct: ZdrAccountData, enforced: boolean): ZdrPosture {
  const id = normalizeModelId(modelId);
  const inUser = acct.userModelIds.has(id);
  const inZdr = acct.zdrModelIds.has(id);
  // RED: blocked by the account's privacy settings (request would 404), or no
  // zero-retention endpoint exists for the model (data will be retained — and
  // under enforcement the request would be rejected outright).
  if (!inUser || !inZdr) return "red";
  // Usable and a ZDR endpoint exists: GREEN when we force ZDR routing, YELLOW when
  // ZDR is merely available (a request may still hit a retaining endpoint).
  return enforced ? "green" : "yellow";
}

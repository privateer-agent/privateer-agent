import type { ProviderConfig, ProviderName } from "../config/schema.ts";

// A model offered by a provider, as surfaced in the picker. `id` is the bare model
// id (no "provider:" prefix); `label` is an optional human-friendly name.
export interface ModelInfo {
  id: string;
  label?: string;
}

const TIMEOUT_MS = 12_000;

// Default API roots per provider. These mirror each SDK's default so the listing
// endpoint and the actual chat endpoint stay in sync when no baseURL is configured.
const DEFAULT_BASE: Record<ProviderName, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/api",
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
    case "openrouter": {
      // OpenRouter's model list is public; the key is sent when present but optional.
      const json = (await getJson(
        `${base}/models`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      )) as { data?: { id: string; name?: string }[] };
      return (json.data ?? [])
        .map((m) => ({ id: m.id, label: m.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "ollama": {
      // Locally installed models, via the Ollama daemon's tags endpoint.
      const json = (await getJson(`${base}/tags`, {})) as {
        models?: { name: string }[];
      };
      return (json.models ?? []).map((m) => ({ id: m.name }));
    }
  }
}

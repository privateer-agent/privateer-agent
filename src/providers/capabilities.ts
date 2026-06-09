import type { Config } from "../config/schema.ts";
import { KNOWN_PROVIDERS, type ProviderName } from "../config/schema.ts";
import { PROVIDER_META } from "./catalog.ts";
import { configuredProviders, parseModelSpec } from "./resolve.ts";
import type { Modality } from "../util/images.ts";

// Map a provider-reported input modality string (OpenRouter exposes these) onto our
// taxonomy. "file" is treated as document support since that's what providers use for
// PDFs; unknown strings are ignored.
function fromReported(reported: string[]): Set<Modality> {
  const out = new Set<Modality>();
  for (const r of reported) {
    const m = r.toLowerCase();
    if (m === "image") out.add("image");
    else if (m === "audio") out.add("audio");
    else if (m === "video") out.add("video");
    else if (m === "file" || m === "document" || m === "pdf") out.add("document");
  }
  return out;
}

// Static heuristics per modality, keyed off the model id. Intentionally generous: a
// false positive surfaces a provider error, a false negative silently drops input.
function heuristic(modality: Modality, id: string): boolean {
  switch (modality) {
    case "image":
      if (/vision|-vl\b|\bvl-|pixtral|multimodal|maverick|scout/.test(id)) return true;
      if (/claude-3|claude-(opus|sonnet|haiku)-4|claude-4/.test(id)) return true;
      if (/gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-5|chatgpt-4o|\bo[134](?:-|$)/.test(id)) return true;
      if (/gemini/.test(id)) return true;
      if (/llama-3\.2.*vision|llama-4/.test(id)) return true;
      if (/grok.*vision|grok-4/.test(id)) return true;
      return false;
    case "document": // native PDF input
      if (/claude-3|claude-(opus|sonnet|haiku)-4|claude-4/.test(id)) return true;
      if (/gemini/.test(id)) return true;
      return false;
    case "audio":
      if (/gpt-4o-audio|gpt-4o-realtime|gpt-audio|whisper/.test(id)) return true;
      if (/gemini/.test(id)) return true;
      return false;
    case "video":
      if (/gemini/.test(id)) return true;
      return false;
  }
}

// Whether a model accepts a given input modality. Reported modalities (when the
// provider supplies them) win over the static heuristic.
export function modelSupports(
  modality: Modality,
  _provider: string,
  modelId: string,
  reported?: string[],
): boolean {
  if (reported) return fromReported(reported).has(modality);
  return heuristic(modality, modelId.toLowerCase());
}

// The full set of input modalities a model accepts.
export function modalitiesFor(provider: string, modelId: string, reported?: string[]): Set<Modality> {
  if (reported) return fromReported(reported);
  const out = new Set<Modality>();
  for (const m of ["image", "document", "audio", "video"] as Modality[]) {
    if (heuristic(m, modelId.toLowerCase())) out.add(m);
  }
  return out;
}

// Providers to consider for auto-pick, in preference order: the provider behind the
// configured default model first, then any other configured providers.
function providerOrder(config: Config): ProviderName[] {
  const ready = new Set(configuredProviders(config).filter((p) => p.ready).map((p) => p.name));
  let primary: ProviderName | undefined;
  try {
    const p = parseModelSpec(config.defaultModel).provider;
    if ((KNOWN_PROVIDERS as readonly string[]).includes(p)) primary = p as ProviderName;
  } catch {
    /* malformed defaultModel → no primary */
  }
  const rest = KNOWN_PROVIDERS.filter((p) => p !== primary && ready.has(p));
  return [...(primary && ready.has(primary) ? [primary] : []), ...rest];
}

// Hybrid auto-pick for a modality route: when no model is configured for `modality`
// and the default can't handle it, return a known capable "provider:model" from a
// configured provider, or null if none qualifies. Reuses each provider's catalog
// default — no network call.
export function suggestModelFor(modality: Modality, config: Config): string | null {
  for (const provider of providerOrder(config)) {
    const spec = PROVIDER_META[provider].defaultModel;
    const { modelId } = parseModelSpec(spec);
    if (modelSupports(modality, provider, modelId)) return spec;
  }
  return null;
}

// Back-compat shims for the original vision-only API.
export function modelSupportsVision(provider: string, modelId: string, reported?: string[]): boolean {
  return modelSupports("image", provider, modelId, reported);
}
export function suggestVisionModel(config: Config): string | null {
  return suggestModelFor("image", config);
}

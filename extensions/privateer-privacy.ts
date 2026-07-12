// pi-privacy for privateer-agent: the standard pi-privacy extension (providers +
// attestation + posture badge feed + PII gate) PLUS a tier resolver that teaches it
// about the private ACCOUNT channel it doesn't ship — so a privateer/near… model
// (actually confidential-compute TEE) is treated as verified-private (no PII
// over-warning), and a zdr account model as zdr-policy. Replaces loading pi-privacy's
// default entry directly.
//
// It also WIDENS the tinfoil provider's model list. pi-privacy registers `tinfoil` with
// a single seed model, so any other Tinfoil model — notably our default `tinfoil/glm-5-2`
// — resolves as a "custom model id" with a startup warning and never shows in the picker.
// We re-register tinfoil with its current chat catalog AFTER pi-privacy runs (a second
// registerProvider call replaces the provider's model list; pi-privacy registers
// synchronously, so ours lands second and wins). This is purely a display/resolution
// list — posture and attestation are dispatcher-bound and unaffected by the model set.
import { makePiPrivacyExtension } from "pi-privacy";
import { accountPosture } from "../src/providers/account.ts";

// Tinfoil's live chat models (inference.tinfoil.sh/v1/models), glm-5-2 first — the
// launcher's default. Non-chat endpoints (embeddings, tts, whisper, websearch,
// doc-upload) are intentionally omitted. Refresh from the live catalog if Tinfoil adds
// models; this static list just needs to cover what we default to and commonly pick.
const TINFOIL_MODELS = [
  "glm-5-2",
  "kimi-k2-6",
  "deepseek-v4-pro",
  "gpt-oss-120b",
  "gpt-oss-safeguard-120b",
  "gemma4-31b",
  "llama3-3-70b",
];

function tinfoilModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

const privacy = makePiPrivacyExtension({
  resolveTier: async (provider, modelId) => {
    if (provider !== "privateer") return undefined; // pi-privacy handles its own providers
    return (await accountPosture(modelId)).tier;
  },
});

export default function privateerPrivacy(pi: any): void {
  privacy(pi);
  // Re-register tinfoil with the fuller catalog. Mirrors pi-privacy's provider config
  // (baseUrl/api + ${TINFOIL_API_KEY} template with authHeader); only the model list is
  // widened so `tinfoil/glm-5-2` and friends resolve without the "custom model id" warning.
  pi.registerProvider?.("tinfoil", {
    name: "Tinfoil (private TEE inference)",
    baseUrl: "https://inference.tinfoil.sh/v1",
    api: "openai-completions",
    apiKey: "${TINFOIL_API_KEY}",
    authHeader: true,
    models: TINFOIL_MODELS.map(tinfoilModel),
  });
}

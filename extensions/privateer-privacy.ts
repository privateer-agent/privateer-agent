// pi-privacy for privateer-agent: the standard pi-privacy extension (providers +
// attestation + posture badge feed + PII gate) configured the way every Privateer session
// configures it — src/config/privacyPolicy.ts, which src/config/moat.ts hands to the
// factory-built sessions verbatim. Chiefly that means a tier resolver teaching pi-privacy
// about the private ACCOUNT channel it doesn't ship, so a privateer/near… model (actually
// confidential-compute TEE) is treated as verified-private (no PII over-warning) and a zdr
// account model as zdr-policy. Replaces loading pi-privacy's default entry directly.
//
// It also REPAIRS two provider registrations pi-privacy makes from its own catalog, each
// of which replaces (not merges) whatever model list that provider already had:
//
//   - `tinfoil` gets a single seed model, so any other Tinfoil model — notably our
//     default (TINFOIL_DEFAULT_SPEC) — resolves as a "custom model id" with a startup warning
//     and never shows in the picker. We re-register it with the current chat catalog.
//   - `privateer` gets pi-privacy's PUBLIC developer-key channel (api.privateer.pro/v1 +
//     `${PRIVATEER_API_KEY}`, one seed model), which clobbers the ACCOUNT channel our own
//     privateer-account extension registers. That is our default model's provider, so the
//     same "not found for provider privateer" warning followed — and worse, the model Pi
//     synthesized pointed at the public endpoint instead of `/api/agent/v1`. We re-assert
//     the account registration (see registerAccountModels).
//
// Both repairs run AFTER pi-privacy inside this same extension, so ours land second and
// win regardless of the order pi discovers extensions in. This is purely a
// display/resolution + routing list — posture and attestation are dispatcher-bound and
// unaffected by the model set.
import { registerAccountModels } from "../src/providers/account.ts";
import { visionInput } from "../src/providers/vision.ts";
import { privacyExtension } from "../src/config/privacyPolicy.ts";

// Tinfoil's live chat models (inference.tinfoil.sh/v1/models), gemma4-31b first — the
// launcher's default, and the only one here that can see an image. Non-chat endpoints (embeddings, tts, whisper, websearch,
// doc-upload) are intentionally omitted. Refresh from the live catalog if Tinfoil adds
// models; this static list just needs to cover what we default to and commonly pick.
const TINFOIL_MODELS = [
  "gemma4-31b",
  "kimi-k2-6",
  "glm-5-2",
  "deepseek-v4-pro",
  "gpt-oss-120b",
  "gpt-oss-safeguard-120b",
  "llama3-3-70b",
];

function tinfoilModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    // Tinfoil ids are bare here (`gemma4-31b`), so scope it before asking — the
    // allowlist is written against full `provider/model` ids. Getting this wrong is
    // not cosmetic: `input` is what Pi checks before it will send an image at all.
    input: visionInput(`tinfoil/${id}`),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

// One configuration, shared with the factory-built copy in src/config/moat.ts — the tier
// resolver for the private ACCOUNT channel, the unattended/no-quarter handling, the ingest
// policy, the operator's PII allowlist and the `/privacy` command that maintains it.
// Adding an option HERE rather than there is how this file and the moat drifted twice;
// src/config/privacyPolicy.ts records what that cost.
const privacy = privacyExtension();

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
  // Put the ACCOUNT channel back over pi-privacy's public developer-key `privateer`.
  registerAccountModels(pi);
}

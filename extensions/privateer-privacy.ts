// pi-privacy for privateer-agent: the standard pi-privacy extension (providers +
// attestation + posture badge feed + PII gate) PLUS a tier resolver that teaches it
// about the private ACCOUNT channel it doesn't ship — so a privateer/near… model
// (actually confidential-compute TEE) is treated as verified-private (no PII
// over-warning), and a zdr account model as zdr-policy. Replaces loading pi-privacy's
// default entry directly.
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
import { makePiPrivacyExtension } from "pi-privacy";
import { accountPosture, registerAccountModels } from "../src/providers/account.ts";

// Tinfoil's live chat models (inference.tinfoil.sh/v1/models), kimi-k2-6 first — the
// launcher's default. Non-chat endpoints (embeddings, tts, whisper, websearch,
// doc-upload) are intentionally omitted. Refresh from the live catalog if Tinfoil adds
// models; this static list just needs to cover what we default to and commonly pick.
const TINFOIL_MODELS = [
  "kimi-k2-6",
  "glm-5-2",
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
  // pi-privacy 0.8 added an INGEST gate: credentials arriving in a tool result are
  // redacted before they enter context (they'd otherwise be re-sent every turn and
  // written to the session file on disk). We already redact tool output in
  // src/ext/permissionGate.ts, so its default "warn" would put an interactive prompt
  // in front of something this app has always handled silently — "redact" keeps our
  // UX and still takes the added coverage.
  //
  // The two redactors are COMPLEMENTARY, not duplicative, which is why we run both:
  // ours masks the configured provider keys by exact value (from env/config) plus the
  // provider-specific shapes (sk-/AIza/xai-/gsk_/csk-/vapi_/fw_/Z.ai, auth headers);
  // pi-privacy's catches what shows up in USER code and shell output — AWS AKIA/ASIA,
  // GitHub gh[pousr]_, JWTs, PEM private-key blocks, Slack, Stripe — none of which
  // our patterns match.
  //
  // Order between the two is NOT guaranteed: pi discovers extensions with a bare
  // readdirSync and never sorts, so it's filesystem-dependent (alphabetical on this
  // box today, not by contract). "redact" makes that moot — both handlers run
  // unconditionally and each masks its own patterns, so the surviving content is the
  // same either way. Under "warn" the order WOULD matter, since it decides whether
  // the prompt is raised on a raw key or one we already masked.
  toolResultPolicy: "redact",
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
  // Put the ACCOUNT channel back over pi-privacy's public developer-key `privateer`.
  registerAccountModels(pi);
}

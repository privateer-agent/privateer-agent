// pi-privacy for privateer-agent: the standard pi-privacy extension (providers +
// attestation + posture badge feed + PII gate) PLUS a tier resolver that teaches it
// about the private ACCOUNT channel it doesn't ship — so a privateer/near… model
// (actually confidential-compute TEE) is treated as verified-private (no PII
// over-warning), and a zdr account model as zdr-policy. Replaces loading pi-privacy's
// default entry directly.
import { makePiPrivacyExtension } from "pi-privacy";
import { accountPosture } from "../src/providers/account.ts";

export default makePiPrivacyExtension({
  resolveTier: async (provider, modelId) => {
    if (provider !== "privateer") return undefined; // pi-privacy handles its own providers
    return (await accountPosture(modelId)).tier;
  },
});

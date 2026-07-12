// The privacy-posture badge in Pi's status bar (Phase 6 polish). On model select
// (and at session start) it computes the current model's posture and pins it to the
// footer via ctx.ui.setStatus — so the moat is *visible*: a green shield "Trusted
// Execution" for an attested enclave, a distinct label for a mere ZDR claim.
//
// Handles both surfaces: the account channel (privateer/*, via server-proxy
// attestation) which pi-privacy doesn't know, and everything else via pi-privacy.

import { verifyModelPosture, TIERS, type PrivacyTier } from "pi-privacy";
import { accountPosture } from "../src/providers/account.ts";

const DOT: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴", neutral: "⚪" };

// ANSI so the shield "references the previous color": the TEE tiers used to show a
// green/yellow traffic-light dot — now they show a shield tinted the same color
// (green = verified, yellow = unconfirmed). The status bar renders these escapes.
const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";

// The TEE tiers render as a colored shield + "Trusted Execution" (pi-privacy labels
// these "Verified TEE" / "TEE (unconfirmed)"; we rename to Trusted Execution for the
// privateer badge and swap the dot for a shield). Everything else keeps the dot.
function badgeLabel(tier: PrivacyTier): string | null {
  if (tier === "tee-verified") return `${GREEN}⛉ Trusted Execution${RESET}`;
  if (tier === "tee-unverified") return `${YELLOW}⛉ Trusted Execution (unconfirmed)${RESET}`;
  return null;
}

async function badgeFor(provider: string, modelId: string): Promise<string> {
  const res =
    provider === "privateer"
      ? await accountPosture(modelId)
      : await verifyModelPosture(provider, modelId, {
          apiKey: provider === "nearai" ? process.env.NEARAI_API_KEY ?? process.env.NEAR_AI_API_KEY : undefined,
        });
  const shield = badgeLabel(res.tier as PrivacyTier);
  if (shield) return shield;
  const info = TIERS[res.tier as PrivacyTier];
  return `${DOT[info.posture] ?? "⚪"} ${info.label}`;
}

export default function privateerPosture(pi: any): void {
  // "latest wins" so rapid model cycling (Ctrl+P) doesn't leave a stale badge.
  let seq = 0;
  const update = async (provider?: string, modelId?: string, ctx?: any) => {
    if (!provider || !modelId || !ctx?.ui?.setStatus) return;
    const mine = ++seq;
    try {
      ctx.ui.setStatus("privacy", "⛉ …"); // immediate placeholder while attesting
      const badge = await badgeFor(provider, modelId);
      if (mine === seq) ctx.ui.setStatus("privacy", badge);
    } catch {
      if (mine === seq) ctx.ui.setStatus("privacy", undefined);
    }
  };

  pi.on("model_select", (event: any, ctx: any) => update(event?.model?.provider, event?.model?.id, ctx));
  pi.on("session_start", (_event: any, ctx: any) => update(ctx?.model?.provider, ctx?.model?.id, ctx));
}

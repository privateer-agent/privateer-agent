// The privacy-posture badge in Pi's status bar (Phase 6 polish). On model select
// (and at session start) it computes the current model's posture and pins it to the
// footer via ctx.ui.setStatus — so the moat is *visible*: a green shield "Trusted
// Execution" for an attested enclave, a distinct label for a mere ZDR claim.
//
// Handles both surfaces: the account channel (privateer/*, via server-proxy
// attestation) which pi-privacy doesn't know, and everything else via pi-privacy.

import { verifyModelPosture, TIERS, type PrivacyTier } from "pi-privacy";
import { accountPosture } from "../src/providers/account.ts";
import { type Palette, paletteFor } from "../src/ui/palette.ts";

const DOT: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴", neutral: "⚪" };

// The shield "references the previous color": the TEE tiers show a shield tinted like the
// old traffic-light dot (green = verified, yellow = unconfirmed). The colours come from
// the active theme (paletteFor) so the badge stays legible on a light terminal too — a
// bare "\x1b[33m" yellow washes out on white. The status bar renders these escapes.
function badgeLabel(tier: PrivacyTier, p: Palette): string | null {
  if (tier === "tee-verified") return `${p.GREEN}⛉ Trusted Execution${p.RESET}`;
  if (tier === "tee-unverified") return `${p.YELLOW}⛉ Trusted Execution (unconfirmed)${p.RESET}`;
  return null;
}

async function badgeFor(provider: string, modelId: string, p: Palette): Promise<string> {
  const res =
    provider === "privateer"
      ? await accountPosture(modelId)
      : await verifyModelPosture(provider, modelId, {
          apiKey: provider === "nearai" ? process.env.NEARAI_API_KEY ?? process.env.NEAR_AI_API_KEY : undefined,
        });
  const shield = badgeLabel(res.tier as PrivacyTier, p);
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
      const badge = await badgeFor(provider, modelId, paletteFor(ctx?.ui?.theme));
      if (mine === seq) ctx.ui.setStatus("privacy", badge);
    } catch {
      if (mine === seq) ctx.ui.setStatus("privacy", undefined);
    }
  };

  pi.on("model_select", (event: any, ctx: any) => update(event?.model?.provider, event?.model?.id, ctx));
  pi.on("session_start", (_event: any, ctx: any) => update(ctx?.model?.provider, ctx?.model?.id, ctx));
}

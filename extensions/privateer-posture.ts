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
import { onPrivacyDisabledChange, privacyDisabled } from "../src/config/privacyDisabled.ts";

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

export async function updatePostureBadge(ctx: any, provider?: string, modelId?: string): Promise<void> {
  if (!ctx?.ui?.setStatus) return;
  if (privacyDisabled()) {
    ctx.ui.setStatus("privacy", "⚑ privacy off");
    ctx.ui.setStatus("pi-privacy", undefined);
    return;
  }
  const p = provider ?? ctx?.model?.provider;
  const m = modelId ?? ctx?.model?.id;
  if (!p || !m) {
    ctx.ui.setStatus("privacy", undefined);
    return;
  }
  try {
    ctx.ui.setStatus("privacy", "⛉ …");
    const badge = await badgeFor(p, m, paletteFor(ctx?.ui?.theme));
    ctx.ui.setStatus("privacy", badge);
  } catch {
    ctx.ui.setStatus("privacy", undefined);
  }
}

export default function privateerPosture(pi: any): void {
  // "latest wins" so rapid model cycling (Ctrl+P) doesn't leave a stale badge.
  let seq = 0;
  const update = async (provider?: string, modelId?: string, ctx?: any) => {
    if (!ctx?.ui?.setStatus) return;
    if (privacyDisabled()) {
      ctx.ui.setStatus("privacy", "⚑ privacy off");
      ctx.ui.setStatus("pi-privacy", undefined);
      return;
    }
    if (!provider || !modelId) return;
    const mine = ++seq;
    try {
      ctx.ui.setStatus("privacy", "⛉ …"); // immediate placeholder while attesting
      const badge = await badgeFor(provider, modelId, paletteFor(ctx?.ui?.theme));
      if (mine === seq) ctx.ui.setStatus("privacy", badge);
    } catch {
      if (mine === seq) ctx.ui.setStatus("privacy", undefined);
    }
  };

  // Keep the last ctx a real event handed us: the badge has to be repainted when the
  // privacy flag moves, and the flag can now move with no event behind it at all —
  // the app's shield toggle writes it over the relay (RemoteBridge's onPrivacy), so
  // `/privacy` is no longer the only driver and the CLI's own badge would otherwise
  // sit on "⛉ Trusted Execution" over a session whose filter a phone just took down.
  let lastCtx: any = null;
  pi.on("model_select", (event: any, ctx: any) => {
    lastCtx = ctx;
    return update(event?.model?.provider, event?.model?.id, ctx);
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    lastCtx = ctx;
    return update(ctx?.model?.provider, ctx?.model?.id, ctx);
  });
  onPrivacyDisabledChange(() => {
    void update(lastCtx?.model?.provider, lastCtx?.model?.id, lastCtx);
  });
}

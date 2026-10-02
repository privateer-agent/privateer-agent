// Private mode — the contract another agent relies on when it hands Privateer data it
// must not see itself.
//
// The handoff: an agent running on a model that is NOT private (a hosted frontier model,
// say) has a task that touches sensitive files. It keeps them out of its own context by
// asking Privateer to do the reading: `privateer -p --private "…"`, or an ACP session
// with `acp.private`. That only works if Privateer refuses to put those files in front of
// a model that isn't private either. A config that quietly fell back to a BYO-key model,
// a sealed shim that never came up, an attestation that came back yellow: each would
// send the very data the caller was keeping out of its own provider to someone else's.
//
// So private mode is enforced where the data enters the model: at the TOOL CALL. Before
// any tool runs, the session's current model must resolve to a verified-private tier —
// `tee-verified` (an enclave quote we checked) or `local` (on this machine). Anything
// else, including a check that throws, blocks the tool. The caller's own prompt still
// reaches the model, by design: it is the caller's text, and the caller already holds it.
// What never reaches an unverified model is anything Privateer READ on the caller's
// behalf.
//
// The second half is egress. A private model does not make a tool call private: a
// web_fetch carrying a file's contents leaves the machine no matter where inference ran.
// Private mode therefore runs on an ALLOWLIST of tools that stay on this machine, and
// refuses shell commands that reach the network, before any mode or approval is
// consulted — so no-quarter, `acp.posture: "auto"` and an approval cannot lift it.
//
// Turned on by `--private` (the launcher sets PRIVATEER_PRIVATE=1) or `acp.private`.
// The env var is honoured from the ambient environment on purpose: unlike the spend
// grants it can only ever make a run STRICTER, so an orchestrator may export it once
// for every Privateer it spawns. Subagent children inherit it with the rest of the env.
//
// IMPORT-SAFETY: the gate imports this module statically, and the gate must stay
// import-order-safe, so the Pi-touching posture code is imported dynamically below.

import type { PrivacyTier } from "pi-privacy";
import { reachesNetwork } from "./danger.ts";

export const PRIVATE_ENV = "PRIVATEER_PRIVATE";

/** True when the environment asks for private mode. */
export function privateModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[PRIVATE_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** The tiers a sensitive file may be shown to. Nothing weaker, and nothing asserted. */
export const PRIVATE_TIERS: ReadonlySet<PrivacyTier> = new Set<PrivacyTier>(["tee-verified", "local"]);

/**
 * Tools that keep their effects on this machine. Everything else (web, crypto lookups,
 * media generation, MCP, app/library uploads, routines, screen control) is refused in
 * private mode, because each one can carry what was read to a third party. `bash` and
 * `terminal` are here but also pass through reachesNetwork().
 */
export const PRIVATE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "terminal",
  // Children inherit PRIVATEER_PRIVATE and run this same check against their own model.
  "subagent",
  "contact_supervisor",
  "intercom",
]);

export interface ModelRef {
  provider?: string;
  id?: string;
  baseUrl?: string;
}

const TTL_MS = 60_000;
const tierCache = new Map<string, { tier: PrivacyTier; at: number }>();

/** Test seam: swap how a model's tier is resolved. */
let resolveTierImpl: (m: Required<Pick<ModelRef, "provider" | "id">> & ModelRef) => Promise<PrivacyTier> = defaultResolveTier;
export function setTierResolverForTests(fn: typeof resolveTierImpl | undefined): void {
  resolveTierImpl = fn ?? defaultResolveTier;
  tierCache.clear();
}

async function defaultResolveTier(m: Required<Pick<ModelRef, "provider" | "id">> & ModelRef): Promise<PrivacyTier> {
  // The account channel's verdict is ours to give (see config/privacyPolicy.ts
  // resolveTier); every other provider is pi-privacy's, which attests TEE providers live
  // and never returns tee-verified from a static claim.
  if (m.provider === "privateer") {
    const { accountPosture } = await import("../providers/account.ts");
    return (await accountPosture(m.id)).tier;
  }
  const { verifyModelPosture } = await import("pi-privacy");
  const apiKey = m.provider === "nearai" ? process.env.NEARAI_API_KEY : undefined;
  return (await verifyModelPosture(m.provider, m.id, { baseUrl: m.baseUrl, apiKey })).tier;
}

/** The model's privacy tier, from a short cache. A failure is not a tier — it throws. */
export async function modelTier(model: ModelRef): Promise<PrivacyTier> {
  if (!model.provider || !model.id) throw new Error("no model selected");
  const key = `${model.provider}/${model.id}@${model.baseUrl ?? ""}`;
  const hit = tierCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tier;
  const tier = await resolveTierImpl({ ...model, provider: model.provider, id: model.id });
  tierCache.set(key, { tier, at: Date.now() });
  return tier;
}

const label = (m: ModelRef | undefined) => (m?.provider && m?.id ? `${m.provider}/${m.id}` : "no model");

/**
 * Why this tool call may not run in private mode, or undefined when it may. Never
 * throws: any failure to establish privacy is itself the refusal.
 */
export async function privateRefusal(toolName: string, input: unknown, model: ModelRef | undefined): Promise<string | undefined> {
  if (!PRIVATE_TOOLS.has(toolName)) {
    return `${toolName} is unavailable in private mode: it can carry what this session has read off this machine. Work with local files only.`;
  }
  if (toolName === "bash" || toolName === "terminal") {
    const obj = (input ?? {}) as Record<string, unknown>;
    const command = String(obj.command ?? obj.cmd ?? obj.script ?? "");
    if (reachesNetwork(command)) {
      return `This command reaches the network, which private mode refuses: it could carry what this session has read off this machine. Use local commands only.`;
    }
  }
  let tier: PrivacyTier;
  try {
    tier = await modelTier(model ?? {});
  } catch (e) {
    return `Private mode could not verify ${label(model)} (${e instanceof Error ? e.message : String(e)}), so no tool may run: its output would reach a model that isn't proven private. Stop and report this; do not retry.`;
  }
  if (!PRIVATE_TIERS.has(tier)) {
    return `Private mode: ${label(model)} is "${tier}", not a verified-private model, so no tool may run: its output would reach a model that isn't proven private. Stop and report this; do not retry.`;
  }
  return undefined;
}

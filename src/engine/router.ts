import type { LanguageModel, ModelMessage } from "ai";
import type { Modality } from "../util/images.ts";

export type { Modality };

// The named routes the engine can switch between per turn. `default` is always
// present (it's the session's configured model); the rest are optional specialized
// targets resolved from the `router` config block.
export type RouteName = "default" | "vision" | "document" | "audio" | "video" | "long" | "fast";

// Routes that exist to satisfy a specific input modality, in the order we prefer them
// when several could cover a turn's requirements.
const MODALITY_ROUTES: { name: RouteName; modality: Modality }[] = [
  { name: "vision", modality: "image" },
  { name: "document", modality: "document" },
  { name: "audio", modality: "audio" },
  { name: "video", modality: "video" },
];

// A resolved, ready-to-stream model plus the per-model knobs that travel with it
// (Anthropic caching/thinking depend on the model family, so they're per-route) and
// the set of input modalities it accepts (so the router can satisfy a turn's needs).
export interface Route {
  spec: string; // "provider:model"
  model: LanguageModel;
  cacheControl: boolean;
  thinkingBudget?: number;
  label: string; // short display name for UI notices (the model id tail)
  supports: Set<Modality>;
}

export interface RouteSet {
  default: Route;
  vision?: Route;
  document?: Route;
  audio?: Route;
  video?: Route;
  long?: Route;
  fast?: Route;
  longThreshold: number; // estimated tokens above which `long` applies
  fastMaxChars: number; // prompt length at/below which `fast` applies
}

// What the current turn looks like, used to pick a route.
export interface RouteSignals {
  modalities: Set<Modality>; // input modalities anywhere in the conversation (sticky)
  estTokens: number; // estimated tokens of the whole conversation
  promptChars: number; // length of the new user prompt
}

export interface RouteSelection {
  name: RouteName;
  route: Route;
  reason?: string; // short human reason, for the UI notice
  missing?: Modality[]; // modalities the chosen route can't satisfy (warn)
}

function covers(route: Route | undefined, required: Set<Modality>): route is Route {
  if (!route) return false;
  for (const m of required) if (!route.supports.has(m)) return false;
  return true;
}

function missingFrom(route: Route, required: Set<Modality>): Modality[] {
  return [...required].filter((m) => !route.supports.has(m));
}

// Candidate routes to consider for an attachment-bearing turn, in preference order:
// the dedicated modality routes first, then long/fast/default as fallbacks (they may
// happen to be multimodal). Deduped by identity.
function candidateRoutes(routes: RouteSet): Route[] {
  const ordered = [
    ...MODALITY_ROUTES.map((r) => routes[r.name]),
    routes.long,
    routes.fast,
    routes.default,
  ].filter((r): r is Route => Boolean(r));
  return [...new Set(ordered)];
}

// Pick the model for this turn.
//   • If the turn requires input modalities, choose the highest-preference route whose
//     `supports` covers the whole union (capability is a hard requirement). If none
//     fully covers, fall back to the route covering the most, flagging what's missing.
//   • Otherwise apply the soft preferences: long (large context) > fast (short prompt)
//     > default.
export function selectRoute(routes: RouteSet, s: RouteSignals): RouteSelection {
  if (s.modalities.size > 0) {
    const candidates = candidateRoutes(routes);
    const full = candidates.find((r) => covers(r, s.modalities));
    if (full) {
      const name = routeNameOf(routes, full);
      return { name, route: full, reason: reasonFor(s.modalities) };
    }
    // No single route covers everything — pick the one that covers the most and warn.
    let best = routes.default;
    let bestMissing = missingFrom(best, s.modalities);
    for (const r of candidates) {
      const miss = missingFrom(r, s.modalities);
      if (miss.length < bestMissing.length) {
        best = r;
        bestMissing = miss;
      }
    }
    return {
      name: routeNameOf(routes, best),
      route: best,
      reason: reasonFor(s.modalities),
      missing: bestMissing,
    };
  }
  if (routes.long && s.estTokens > routes.longThreshold) {
    return { name: "long", route: routes.long, reason: "long context" };
  }
  if (routes.fast && s.promptChars <= routes.fastMaxChars) {
    return { name: "fast", route: routes.fast, reason: "short prompt" };
  }
  return { name: "default", route: routes.default };
}

function reasonFor(modalities: Set<Modality>): string {
  return `${[...modalities].join("+")} input`;
}

// Recover the route name for a resolved Route (for the UI/event). Falls back to
// "default" if it isn't one of the named slots.
function routeNameOf(routes: RouteSet, route: Route): RouteName {
  const names: RouteName[] = ["vision", "document", "audio", "video", "long", "fast"];
  for (const n of names) if (routes[n] === route) return n;
  return "default";
}

const MEDIA_MODALITY: { test: RegExp; modality: Modality }[] = [
  { test: /^image\//, modality: "image" },
  { test: /^audio\//, modality: "audio" },
  { test: /^video\//, modality: "video" },
  { test: /^application\/pdf$/, modality: "document" },
];

function modalityOfMediaType(mediaType: string): Modality | null {
  return MEDIA_MODALITY.find((m) => m.test.test(mediaType))?.modality ?? null;
}

// The input modalities present anywhere in the conversation. Keyed off the whole
// history (not just the new message) so that once an attachment is in context,
// follow-up turns stay on a model that can accept it rather than replaying it to one
// that can't.
export function requiredModalities(messages: ModelMessage[]): Set<Modality> {
  const out = new Set<Modality>();
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || !("type" in part)) continue;
      const t = (part as { type: string }).type;
      if (t === "image") out.add("image");
      else if (t === "file") {
        const mt = (part as { mediaType?: string }).mediaType;
        const mod = mt ? modalityOfMediaType(mt) : null;
        if (mod) out.add(mod);
      }
    }
  }
  return out;
}

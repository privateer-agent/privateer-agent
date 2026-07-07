// Route/modality types referenced by the EngineEvent `routed` variant.
//
// STUB — the full router (tree-cli/src/engine/router.ts) is DELETE in the
// migration (Pi's model registry + our models.json generator replace it). Only
// the two type names survive as part of the relay wire vocabulary, so they live
// here as a types-only module until the `routed` event's producer is wired in a
// later phase. Kept structurally identical to the original so events.ts ports
// verbatim.
export type Modality = "text" | "image" | "audio" | "video" | "pdf";

export type RouteName = "default" | "vision" | "long-context" | "fast" | (string & {});

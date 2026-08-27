// Which models can actually LOOK at an image — the one place that answers it, for
// every catalog we register.
//
// The bug this fixes: every model we register — the whole 270-model account catalog
// (providers/account.ts seedModel) and Tinfoil's direct catalog
// (extensions/privateer-privacy.ts tinfoilModel) — declared `input: ["text"]`,
// copied from pi-privacy's own seed shape. That field is not decoration. Pi gates
// image handling on it in four places:
//
//   • pi-coding-agent core/tools/read.js — reading a PNG appends "[Current model does
//     not support images. The image will be omitted from this request.]" and drops it;
//   • pi-ai api/openai-completions.js — `hasImages && model.input.includes("image")`,
//     so image blocks are stripped from the request body;
//   • api/transform-messages.js and api/openai-responses-shared.js — same test again.
//
// So a signed-in user could point the agent at a screenshot, a design mock, or a
// generated sprite sheet and get a confident answer about a picture the model was
// never sent. Not a refusal — a silent omission, which is worse. Declaring the
// modality honestly is what makes `read` on an image, and every media tool that hands
// one back, actually reach the model.
//
// WHY AN ALLOWLIST AND NOT A SERVER FIELD: `GET /api/models` returns
// `{ modelId, displayName, provider, rate*, enabled, privacy: { tier } }` and no
// modality at all (checked against the live listing, 273 models, 2026-08-27). Until it
// carries one, the client has to decide, and the two failure directions are NOT
// symmetric:
//
//   • miss a vision model → images are dropped, i.e. exactly today's behaviour;
//   • claim one that isn't → pi-ai sends image_url blocks the upstream rejects and the
//     whole turn 400s.
//
// So this list is deliberately conservative: a family goes in when the id itself says
// vision (`-vl-`, a trailing `v` on a GLM), or when every member of that family has
// shipped multimodal. Anything uncertain stays out and keeps the old behaviour.

// Ids arrive in three shapes and all three must match the same rules:
//   `anthropic/claude-opus-5`            — account catalog, vendor/model
//   `near/Qwen/Qwen3-VL-30B-A3B-Instruct` — account catalog, tee/vendor/model
//   `gemma4-31b`                          — Tinfoil's direct catalog, bare id
// Callers holding a bare id should prefix it with its provider (see visionInput's use
// in privateer-privacy.ts); the patterns below are anchored loosely enough that a
// bare `gemma4-31b` still matches on its own.
const VISION_PATTERNS: RegExp[] = [
  // ── Named in the id ────────────────────────────────────────────────────────
  // Qwen's vision line (qwen3-vl-*, qwen2.5-vl-72b, near/Qwen/Qwen3-VL-30B-A3B) and
  // Baidu's (ernie-4.5-vl-424b). Qwen ships VL as a SEPARATE line, which is also why
  // the plain qwen3.x ids below are deliberately absent.
  /-vl[-_.]/i,
  // Z.ai marks vision with a trailing v on the version: glm-4.5v, glm-4.6v,
  // glm-5v-turbo. Same reasoning — the unsuffixed glm-5.x are their text siblings.
  /\bglm-\d+(?:\.\d+)?v\b/i,
  // ByteDance's GUI agent reads screenshots; that is the whole point of it.
  /\bui-tars\b/i,

  // ── Families that are multimodal throughout ────────────────────────────────
  // Every Claude from 3 onwards takes images, and 3 is the oldest in the catalog.
  /(^|\/)anthropic\/claude-/i,
  // Gemini has been multimodal since 1.0.
  /(^|\/)google\/gemini-/i,
  // Gemma from 3 on is multimodal; gemma-2 is not, so the version is part of the
  // match. Covers google/gemma-3-27b-it, google/gemma-4-31b-it, tinfoil/gemma4-31b,
  // near/google/gemma-4-31B-it, phala/google/gemma-4-31b-it and the Phala
  // gemma-4 derivatives.
  /gemma-?[34]/i,
  // gpt-4o, gpt-4.1 and the whole gpt-5 line. Deliberately NOT `openai/gpt-4`
  // (the original is text-only), not gpt-3.5, and not gpt-oss — the open-weights
  // models are text-only, which is what our own default was until this change.
  /(^|\/)openai\/gpt-(?:4o|4\.1|5)/i,
  // Llama 4 (maverick, scout) is natively multimodal; 3.x is not.
  /(^|\/)meta-llama\/llama-4-/i,
  // Nova lite/pro/premier take images; nova-micro is text-only.
  /(^|\/)amazon\/nova-(?:2-)?(?:lite|pro|premier)/i,
  // Grok 4 and up.
  /(^|\/)x-ai\/grok-4/i,
  // Mistral's multimodal tiers: small 3.2 and the medium 3 line.
  /(^|\/)mistralai\/mistral-(?:small-3\.2|medium-3)/i,
];

/** Whether `modelId` can be sent an image. See the note above on why it's an allowlist. */
export function acceptsImages(modelId: string): boolean {
  return VISION_PATTERNS.some((re) => re.test(modelId));
}

/**
 * The `input` modality array for a registered model entry.
 *
 * pi-ai's ModelData only knows `"text" | "image"` — there is no video or pdf modality
 * to declare, so a clip or a document reaches the model through a TOOL (media.ts's
 * generators, `read` for a file) rather than as an input block. Image is therefore the
 * whole of what this field can say, and saying it correctly is what lets `read` attach
 * a screenshot instead of quietly dropping it.
 */
export function visionInput(modelId: string): ("text" | "image")[] {
  return acceptsImages(modelId) ? ["text", "image"] : ["text"];
}

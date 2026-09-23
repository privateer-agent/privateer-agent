// Seeing on behalf of a model that can't.
//
// providers/vision.ts makes a text-only model HONEST about images — it declares
// `input: ["text"]`, and Pi then drops every image block on the way to the provider.
// Honest, but blind: a user on glm-5-2 who points the agent at a screenshot still
// gets an answer about a picture the model never saw, just with a note saying so.
//
// This module closes that gap. Before each LLM call (Pi's `context` event) every
// image in the outgoing messages is handed to a vision-capable model and replaced
// with that model's description — so the text-only model gets words where it would
// have got nothing. The session itself keeps the original images: only the
// per-request copy is rewritten, so switching to a vision model later still sends
// the real pixels.
//
// WHICH delegate — "the key type provided". The delegate must be reachable with the
// credential the user is ALREADY using, i.e. the same provider as the current model:
//
//   privateer/* (account)  → privateer/tinfoil/gemma4-31b, the confidential default
//   tinfoil/*   (TEE key)  → tinfoil/gemma4-31b
//   openrouter/* …         → the best vision model that provider serves
//
// Never a different provider. Crossing providers would ship the user's screenshot
// to a company they did not pick for this session — on a privacy-first agent that
// is not a fallback, it's a leak. If the current provider has no vision model with
// working auth, nothing is rewritten and Pi's existing "image omitted" behaviour
// stands. PRIVATEER_VISION_MODEL=<provider/id> overrides the choice (and is the one
// deliberate way to cross providers).

import { createHash } from "node:crypto";
import { ACCOUNT_DEFAULT_MODEL_ID, TINFOIL_MODEL_ID } from "./defaultModel.ts";

export interface VisionModel {
  provider: string;
  id: string;
  input: string[];
}

/** The slice of Pi's ModelRegistry this module needs (kept structural). */
export interface VisionRegistry {
  getAvailable(): VisionModel[];
  find(provider: string, id: string): VisionModel | undefined;
  hasConfiguredAuth(model: VisionModel): boolean;
  complete(model: any, context: any, options?: any): Promise<{ content: any[]; stopReason?: string; errorMessage?: string }>;
}

const specOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
const seesImages = (m: { input?: string[] }) => Array.isArray(m.input) && m.input.includes("image");

// Per-provider first choices, tried before "any vision model on this provider". Only
// providers where the pick matters are listed: on the account channel it keeps the
// image inside the attested Tinfoil enclave rather than whichever vision model sorts
// first; elsewhere the registry's own list is good enough.
const PREFERRED: Record<string, string[]> = {
  privateer: [ACCOUNT_DEFAULT_MODEL_ID],
  tinfoil: [TINFOIL_MODEL_ID.replace(/^tinfoil\//, "")],
  openrouter: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
};

/**
 * The model that should look at images for `current`, or undefined when there is no
 * reachable vision model on the same key. Returns undefined for a model that can
 * already see — there is nothing to delegate.
 */
export function pickVisionDelegate(
  current: VisionModel | undefined,
  registry: VisionRegistry,
  env: NodeJS.ProcessEnv = process.env,
): VisionModel | undefined {
  if (!current || seesImages(current)) return undefined;
  const usable = (m: VisionModel | undefined): m is VisionModel =>
    !!m && seesImages(m) && registry.hasConfiguredAuth(m);

  const override = env.PRIVATEER_VISION_MODEL?.trim();
  if (override) {
    const slash = override.indexOf("/");
    const m = slash > 0 ? registry.find(override.slice(0, slash), override.slice(slash + 1)) : undefined;
    if (usable(m)) return m;
  }

  for (const id of PREFERRED[current.provider] ?? []) {
    const m = registry.find(current.provider, id);
    if (usable(m)) return m;
  }
  return registry.getAvailable().find((m) => m.provider === current.provider && usable(m));
}

// Pi's read tool appends this to an image it knows the model can't see. Once we've
// described the image the note is false, and leaving it in invites the model to tell
// the user it couldn't look.
const OMITTED_NOTE = /\n?\[Current model does not support images\. The image will be omitted from this request\.\]/g;

const SYSTEM_PROMPT = [
  "You are the eyes for another AI model that cannot see images.",
  "Describe the image so that model can act on it without seeing it.",
  "Transcribe ALL legible text verbatim (code, error messages, labels, numbers), preserving line breaks.",
  "Then describe layout, UI elements and their state, colors where meaningful, charts/diagrams and what they show, and anything unusual.",
  "Be precise and factual. Do not speculate beyond what is visible. No preamble.",
].join(" ");

type Block = { type: string; text?: string; data?: string; mimeType?: string };

const cache = new Map<string, Promise<string>>();

/** Test hook: forget every cached description. */
export function clearVisionCache(): void {
  cache.clear();
}

function describe(
  registry: VisionRegistry,
  delegate: VisionModel,
  image: Block,
  hint: string,
  signal?: AbortSignal,
): Promise<string> {
  const key = `${specOf(delegate)}:${createHash("sha256").update(image.data ?? "").digest("hex")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const res = await registry.complete(
      delegate,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: hint ? `Context it appeared in:\n${hint.slice(0, 2000)}\n\nDescribe this image.` : "Describe this image." },
              { type: "image", data: image.data, mimeType: image.mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { signal, cacheRetention: "none" },
    );
    if (res.stopReason === "error" || res.stopReason === "aborted") {
      throw new Error(res.errorMessage || `vision model ${res.stopReason}`);
    }
    const text = res.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
    if (!text) throw new Error("vision model returned no description");
    return text;
  })();
  cache.set(key, job);
  // A failure must not stick: the next turn should get another try.
  job.catch(() => cache.delete(key));
  return job;
}

/**
 * Rewrite `messages` so every image block becomes a text description from
 * `delegate`. Returns undefined when there was nothing to rewrite. Never throws: an
 * image that can't be described becomes a note saying so (Pi would have dropped it
 * anyway), so one bad image can't fail the turn.
 */
export async function describeImagesInMessages(
  messages: any[],
  delegate: VisionModel,
  registry: VisionRegistry,
  opts: { currentSpec: string; signal?: AbortSignal; onDescribe?: (count: number) => void } = { currentSpec: "" },
): Promise<any[] | undefined> {
  const jobs: Array<{ block: Block; hint: string }> = [];
  for (const msg of messages) {
    if (!msg || msg.role === "assistant" || !Array.isArray(msg.content)) continue;
    const hint = (msg.content as Block[])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .replace(OMITTED_NOTE, "");
    for (const b of msg.content as Block[]) if (b?.type === "image" && b.data) jobs.push({ block: b, hint });
  }
  if (jobs.length === 0) return undefined;
  opts.onDescribe?.(jobs.length);

  const results = new Map<Block, string>();
  await Promise.all(
    jobs.map(async ({ block, hint }) => {
      try {
        const text = await describe(registry, delegate, block, hint, opts.signal);
        results.set(block, `[Image — ${opts.currentSpec || "this model"} can't see images, so ${specOf(delegate)} described it:]\n${text}`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        results.set(block, `[Image omitted — ${specOf(delegate)} could not describe it: ${why}]`);
      }
    }),
  );

  return messages.map((msg) => {
    if (!msg || msg.role === "assistant" || !Array.isArray(msg.content)) return msg;
    if (!(msg.content as Block[]).some((b) => results.has(b))) return msg;
    const content = (msg.content as Block[]).map((b) => {
      const described = results.get(b);
      if (described !== undefined) return { type: "text", text: described };
      if (b?.type === "text" && b.text) return { ...b, text: b.text.replace(OMITTED_NOTE, "") };
      return b;
    });
    return { ...msg, content };
  });
}

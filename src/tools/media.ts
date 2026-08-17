// Media generation — images, video, speech, and music, billed to the signed-in
// Privateer account and written straight to disk as files the agent can then work on.
//
// WHY THROUGH THE ACCOUNT. Same reasoning as web.ts: the only secret in the process is
// the user's own session token. No provider key sits in the environment for a
// prompt-injected run to read out, and every call inherits the account's entitlement,
// daily caps, credit balance, and — the part that matters most here — its ZDR posture.
// The server refuses to route a ZDR account's media to a retaining model unless the
// user has explicitly opted into non-ZDR media (`ZDR_MEDIA_BLOCKED`), and these tools
// surface that refusal verbatim rather than papering over it.
//
// WHAT THIS COSTS, HONESTLY. Generation is NOT encrypted and cannot be. The
// prompt, any input image, and the finished bytes pass through Privateer's servers in
// plaintext on the way to and from the model provider — that is what generation IS.
// What we do control: nothing is persisted server-side. The bytes come back inline and
// land only in the file you name. Never describe a routine that generates media as
// fully private; do say the output isn't stored in our cloud.
//
// MUSIC IS THE LOOSEST OF THESE. Neither Lyria SKU has a zero-retention endpoint and no
// confidential music model exists, so music is deliberately exempt from the ZDR gate
// (the server sends it unattributed as the mitigation). The tool description says so,
// because a model choosing between "narrate this" and "score this" should know the
// difference in posture before it picks.
//
// SOUND EFFECTS ARE NOT THE SAME CASE, and the distinction is easy to get backwards.
// Every effect model is on fal, which is simply a non-ZDR provider — that is the exact
// situation the ZDR gate exists for, so `/api/audio/sfx` gates like image and video do
// and a default (ZDR-on) account is REFUSED until its owner enables non-ZDR media. Music
// skips the gate because gating it would leave an empty picker; sfx has no such excuse.
// So: never tell a user that sfx is exempt the way music is, and never suggest music as a
// ZDR-friendly substitute for an effect — it is the one with no gate at all.
//
// SHAPE. Every tool takes an explicit output `path` and returns that path. That is not
// bookkeeping: it makes the permission gate meaningful (a media call classifies as a
// write against a named file, see permissions/classify.ts), and it gives the NEXT step
// in a workflow — video_compose, send_file_to_client, a bash ffmpeg call — something
// concrete to consume. A workflow is then just: generate frames → animate them →
// stitch → score → send.

import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { apiRequest } from "../auth/privateer.ts";

/** Tool names these definitions register, for allow-list construction. */
export const MEDIA_TOOL_NAMES = [
  "generate_image",
  "generate_video",
  "generate_model",
  "generate_speech",
  "generate_music",
  "generate_sfx",
  "media_capabilities",
] as const;

// A video job can legitimately take minutes. Bound the wait so a wedged provider
// doesn't pin an unattended run forever; the job id is reported on timeout so the
// caller can resume the poll rather than pay for another generation.
const VIDEO_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_VIDEO_TIMEOUT_MS) || 12 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
// A mesh job runs about a minute at the provider's stated typical time, and
// several for a large face count. Same bounded-wait contract as video: the job
// id is reported on timeout so the caller can resume the poll rather than pay
// for a second generation.
const MESH_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_MESH_TIMEOUT_MS) || 10 * 60_000;
const MESH_POLL_INTERVAL_MS = 5_000;
// Four reference views at 8 MB each would be ~43 MB of base64 — past the
// server's own body limit, so the request would be refused by a JSON parser with
// a message about payload size rather than about pictures. Caught here first,
// where the message can name the files.
const MAX_MESH_VIEWS = 4;
const MAX_MESH_INPUT_TOTAL_BYTES = 12 * 1024 * 1024;
// Bound what we'll upload as an input frame/reference. The server enforces its own
// ceiling; failing here first turns a 413 into a clear, local message.
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

function mimeForImage(path: string): string {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? "image/jpeg";
}

function extForMime(mimeType: string, fallback: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  if (m.includes("ogg")) return ".ogg";
  return fallback;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

// Write bytes to `path`, creating parent directories. Returns a short human summary.
function writeOut(target: string, bytes: Buffer): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  const kb = bytes.length / 1024;
  return `${target} (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`})`;
}

// Read a local image and return it in the wire shape the server expects.
function readInputImage(cwd: string, p: string): { data: string; mimeType: string } {
  const target = abs(cwd, p);
  if (!existsSync(target)) throw new Error(`input image not found: ${p}`);
  const stat = statSync(target);
  if (stat.isDirectory()) throw new Error(`${p} is a directory, not an image`);
  if (stat.size === 0) throw new Error(`${p} is empty`);
  if (stat.size > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`${p} is ${(stat.size / 1048576).toFixed(1)} MB; the limit for an input image is ${MAX_INPUT_IMAGE_BYTES / 1048576} MB`);
  }
  return { data: readFileSync(target).toString("base64"), mimeType: mimeForImage(target) };
}

interface AccountFailure {
  ok: false;
  message: string;
}

/**
 * Call the account API and return the parsed payload, or a message written for the
 * model to read. Errors are surfaced rather than swallowed — an agent that quietly
 * "generated" nothing and moved on is worse than one that says the account is out of
 * credit. The server's own messages are already written for a person, so prefer them.
 */
async function callAccount<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<({ ok: true } & { data: T }) | AccountFailure> {
  let res: Response;
  try {
    res = await apiRequest(path, {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (e) {
    return { ok: false, message: `could not reach Privateer: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.ok || res.status === 202) {
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, message: "Privateer returned a malformed response" };
    }
  }

  let code = "";
  let serverMessage = "";
  try {
    const err = (await res.json()) as { code?: string; message?: string; error?: { code?: string; message?: string } };
    code = String(err?.code ?? err?.error?.code ?? "");
    serverMessage = String(err?.message ?? err?.error?.message ?? "");
  } catch {
    /* non-JSON body — fall through to a status-based message */
  }

  // The ZDR block is a deliberate policy answer, not a failure, and it is ACTIONABLE
  // by the user (not by the model) — say exactly which switch to change and stop.
  if (code === "ZDR_MEDIA_BLOCKED") {
    return {
      ok: false,
      message:
        (serverMessage || "this account requires Zero Data Retention and the media model has no ZDR endpoint") +
        " — this is a privacy setting only the account owner can change (Settings → Privacy), so do not retry.",
    };
  }
  if (code === "ZDR_KEY_UNAVAILABLE") {
    return { ok: false, message: serverMessage || "no zero-retention provider key is available right now — try again later" };
  }
  if (/DAILY_CAP|LIMIT_REACHED/i.test(code) || res.status === 429) {
    return { ok: false, message: serverMessage || "the account's daily media allowance is used up — it resets tomorrow" };
  }
  if (res.status === 402 || /INSUFFICIENT|QUOTA|TOP_?UP/i.test(code)) {
    return { ok: false, message: serverMessage || "the account is out of credit for media generation — top up or upgrade to continue" };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        serverMessage ||
        "this agent is not signed in to a Privateer account (or the plan doesn't include this), so it cannot generate media",
    };
  }
  if (res.status === 400 || res.status === 413) {
    return { ok: false, message: serverMessage || `Privateer rejected the request${code ? ` (${code})` : ""}` };
  }
  // 503/504 are OUR outage or a provider timing out, not a bad request: an unset
  // provider key, our own balance with that provider, or a slow job. Retrying the same
  // call later is the right move, and saying so stops a model from rewriting a perfectly
  // good prompt in the belief it caused this.
  if (res.status === 503 || res.status === 504) {
    return {
      ok: false,
      message: `${serverMessage || "that media service is temporarily unavailable"} — this is on Privateer's side, not the prompt's; try again in a few minutes`,
    };
  }
  return { ok: false, message: serverMessage || `media generation failed (HTTP ${res.status}${code ? ` ${code}` : ""})` };
}

// ── Images ───────────────────────────────────────────────────────────────────

interface ImageResponse {
  model?: string;
  images?: { data?: string; mimeType?: string }[];
}

export const generateImageToolDefinition = {
  name: "generate_image",
  label: "Generate Image",
  description:
    "Generate an image from a text prompt and save it to disk. Optionally pass `images` — paths to " +
    "images already on disk — to EDIT or COMPOSE instead: one input means 'change this picture per the " +
    "prompt', several means 'combine these into one'. Billed to the user's Privateer account and " +
    "subject to its privacy settings; the prompt and any input images pass through Privateer's servers " +
    "in plaintext, but nothing is stored there — the only copy is the file you name. Use the resulting " +
    "path as the first frame of generate_video, or as slideshow material for video_compose.",
  parameters: Type.Object({
    prompt: Type.String({ description: "What the image should show. Be specific about subject, style, lighting and framing." }),
    path: Type.String({ description: "Where to write the image, relative to cwd or absolute (e.g. 'frames/opening.png')." }),
    images: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Paths to existing images to edit or combine. One = edit that image; several = use the first as the base " +
          "and incorporate the rest. Omit to generate from the prompt alone.",
      }),
    ),
    count: Type.Optional(Type.Number({ description: "How many variations to produce, 1-4. Above 1, files are suffixed -1, -2, … Defaults to 1." })),
    aspectRatio: Type.Optional(Type.String({ description: "Aspect ratio, e.g. '16:9', '9:16', '1:1'. Defaults to the model's own." })),
    size: Type.Optional(Type.String({ description: "Explicit pixel size if the model supports one, e.g. '1024x1024'." })),
    model: Type.Optional(Type.String({ description: "Override the account's image model (e.g. 'google/gemini-3.1-flash-image'). Leave unset to use the account default." })),
  }),
  async execute(
    _toolCallId: string,
    params: { prompt: string; path: string; images?: string[]; count?: number; aspectRatio?: string; size?: string; model?: string },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return text("Error: prompt is required.");
    if (!params.path) return text("Error: path is required — say where to save the image.");

    let inputs: { data: string; mimeType: string }[];
    try {
      inputs = (params.images ?? []).map((p) => readInputImage(cwd, p));
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const count = Math.min(Math.max(1, Math.round(params.count ?? 1)), 4);
    const r = await callAccount<ImageResponse>("/api/agent/media/images", {
      method: "POST",
      signal,
      body: {
        prompt,
        n: count,
        ...(inputs.length ? { images: inputs } : {}),
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.size ? { imageSize: params.size } : {}),
        ...(params.model ? { model: params.model } : {}),
      },
    });
    if (!r.ok) return text(`Image generation failed: ${r.message}`);

    const images = r.data.images ?? [];
    if (images.length === 0) return text("Image generation returned no images.");

    // Multi-variation output gets -1/-2 suffixes so nothing overwrites anything; a
    // single image keeps the exact path asked for, which is what a workflow chains on.
    const target = abs(cwd, params.path);
    const ext = extname(target) || extForMime(images[0].mimeType ?? "", ".png");
    const stem = target.slice(0, target.length - extname(target).length);
    const written: string[] = [];
    for (const [i, img] of images.entries()) {
      if (!img.data) continue;
      const out = images.length === 1 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
      written.push(writeOut(out, Buffer.from(img.data, "base64")));
    }
    if (written.length === 0) return text("Image generation returned no usable image data.");

    const verb = inputs.length ? (inputs.length === 1 ? "Edited" : "Composed") : "Generated";
    return text(`${verb} ${written.length} image${written.length === 1 ? "" : "s"} with ${r.data.model ?? "the account image model"}:\n${written.map((w) => `  ${w}`).join("\n")}`);
  },
};

// ── Video ────────────────────────────────────────────────────────────────────

interface VideoSubmitResponse {
  jobId?: string;
  status?: string;
  model?: string;
}
interface VideoStatusResponse {
  status?: string;
  message?: string;
  mimeType?: string;
  data?: string;
  delivered?: boolean;
  model?: string;
}

export const generateVideoToolDefinition = {
  name: "generate_video",
  label: "Generate Video",
  description:
    "Generate a video clip from a text prompt and save it to disk. Give `firstFrame` (a path to an " +
    "image) to animate an existing picture, and `lastFrame` as well to interpolate between two stills — " +
    "that pairing is how you keep several clips visually continuous: end one clip on a frame you " +
    "extracted with video_compose, then start the next from it. Generation takes minutes and this tool " +
    "waits for it. Expensive (roughly $0.10-$1 a clip) and billed to the user's Privateer account, so " +
    "plan the shot before calling. Clip lengths and aspect ratios are model-specific — check " +
    "media_capabilities first if unsure. Stitch the finished clips with video_compose.",
  parameters: Type.Object({
    prompt: Type.String({ description: "What happens in the shot: subject, action, camera move, style." }),
    path: Type.String({ description: "Where to write the video, relative to cwd or absolute (e.g. 'clips/01-opening.mp4')." }),
    firstFrame: Type.Optional(Type.String({ description: "Path to an image to use as the opening frame (image-to-video)." })),
    lastFrame: Type.Optional(Type.String({ description: "Path to an image to use as the closing frame. Requires firstFrame." })),
    seconds: Type.Optional(Type.Number({ description: "Clip length in seconds. Only certain values are legal per model — see media_capabilities." })),
    aspectRatio: Type.Optional(Type.String({ description: "Aspect ratio, e.g. '16:9', '9:16'. Model-specific." })),
    resolution: Type.Optional(Type.String({ description: "Resolution, e.g. '720p' or '1080p'." })),
    audio: Type.Optional(Type.Boolean({ description: "Ask the model to generate a soundtrack too, where it supports one. Costs more. Defaults to false." })),
    model: Type.Optional(Type.String({ description: "Override the account's video model (e.g. 'google/veo-3.1-lite'). Leave unset to use the account default." })),
  }),
  async execute(
    _toolCallId: string,
    params: {
      prompt: string; path: string; firstFrame?: string; lastFrame?: string;
      seconds?: number; aspectRatio?: string; resolution?: string; audio?: boolean; model?: string;
    },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return text("Error: prompt is required.");
    if (!params.path) return text("Error: path is required — say where to save the video.");
    if (params.lastFrame && !params.firstFrame) return text("Error: lastFrame needs firstFrame alongside it.");

    let firstFrame: { data: string; mimeType: string } | undefined;
    let lastFrame: { data: string; mimeType: string } | undefined;
    try {
      if (params.firstFrame) firstFrame = readInputImage(cwd, params.firstFrame);
      if (params.lastFrame) lastFrame = readInputImage(cwd, params.lastFrame);
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const submitted = await callAccount<VideoSubmitResponse>("/api/agent/media/videos", {
      method: "POST",
      signal,
      body: {
        prompt,
        ...(params.seconds != null ? { seconds: params.seconds } : {}),
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        ...(params.audio ? { generateAudio: true } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
      },
    });
    if (!submitted.ok) return text(`Video generation failed: ${submitted.message}`);
    const jobId = submitted.data.jobId;
    if (!jobId) return text("Video generation failed: Privateer did not return a job id.");

    // Poll to completion. The account is charged when the provider delivers, so an
    // abandoned poll still costs money — hence the timeout message names the job id.
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    const cancelled = () =>
      text(`Video job ${jobId} was submitted but the wait was cancelled. It is still running and will still be billed.`);
    for (;;) {
      if (signal?.aborted) return cancelled();
      await sleep(VIDEO_POLL_INTERVAL_MS, signal);
      // sleep() resolves early on abort, so re-check before spending a request on a
      // signal that is already dead — otherwise the cancel surfaces as a network error.
      if (signal?.aborted) return cancelled();
      const poll = await callAccount<VideoStatusResponse>(`/api/agent/media/videos/${encodeURIComponent(jobId)}`, {
        method: "GET",
        signal,
      });
      if (!poll.ok) return text(`Video job ${jobId} could not be polled: ${poll.message}`);

      const status = String(poll.data.status ?? "").toLowerCase();
      if (status === "failed") return text(`Video generation failed: ${poll.data.message ?? "the provider reported a failure"}.`);
      if (status === "completed") {
        if (!poll.data.data) {
          // The bytes were handed out on an earlier poll and are not stored anywhere.
          return text(`Video job ${jobId} already delivered its bytes on an earlier poll; they were not saved. Generate again if the file is missing.`);
        }
        const target = abs(cwd, params.path);
        const ext = extname(target) || extForMime(poll.data.mimeType ?? "", ".mp4");
        const out = `${target.slice(0, target.length - extname(target).length)}${ext}`;
        const summary = writeOut(out, Buffer.from(poll.data.data, "base64"));
        return text(`Generated video with ${poll.data.model ?? submitted.data.model ?? "the account video model"}: ${summary}`);
      }
      if (Date.now() > deadline) {
        return text(
          `Video job ${jobId} is still ${status || "running"} after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 60000)} minutes. ` +
            "It will still complete and still be billed; nothing was saved here.",
        );
      }
    }
  },
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve_) => {
    const t = setTimeout(resolve_, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve_(); }, { once: true });
  });
}

// ── 3D ───────────────────────────────────────────────────────────────────────

interface ModelSubmitResponse {
  jobId?: string;
  status?: string;
  model?: string;
  format?: string;
  estimatedUsd?: number;
}
interface ModelStatusResponse {
  status?: string;
  message?: string;
  format?: string;
  mimeType?: string;
  data?: string;
  delivered?: boolean;
  model?: string;
}

export const generateModelToolDefinition = {
  name: "generate_model",
  label: "Generate 3D Model",
  description:
    "Generate a 3D MESH — a .glb (or .obj) file for a game engine or DCC tool — from one or more " +
    "reference images. (This makes 3D geometry; it has nothing to do with language models.) There is no " +
    "text-to-mesh here: generate the concept art with generate_image first, look at it, and pass that " +
    "path as `images` — which also means the shape is generated from a look someone approved rather " +
    "than from a sentence. Supply up to four views (front, back, left, right) of the SAME object to stop " +
    "the model inventing the sides it cannot see; on some models that costs more and it is usually " +
    "worth it. Generation takes a minute or more and this tool waits for it. EXPENSIVE and billed to " +
    "the user's Privateer account: $0.14 to $2.41 a mesh depending on WHICH model and which options, " +
    "so plan the asset before calling and tell the user the total before batching dozens of them.\n" +
    "There are ten models from five vendors and they are not interchangeable — the dearest costs " +
    "seventeen times the cheapest, and each takes DIFFERENT options. Call media_capabilities (with " +
    "`model` set) to see a model's own options and price before choosing; pass what you picked as " +
    "`axes`. Blocking out a shape is a job for the cheap end; a hero asset is not. PRIVACY: 3D " +
    "generation runs on a provider with no zero-retention option, so it is gated — a ZDR account must " +
    "have enabled non-ZDR media. Call media_capabilities first if unsure.",
  parameters: Type.Object({
    images: Type.Array(Type.String(), {
      description:
        "Paths to reference images of one object, best view first. 1-4 of them, read as front, back, left, right. " +
        "How many are actually USED is per-model — media_capabilities reports `maxViews`, and several " +
        "models take a single view and will quietly ignore the rest, so check before generating four " +
        "images to feed one. Where extra views are used they give the model the sides it would " +
        "otherwise invent; on the Hunyuan models they add $0.15 in total (not each) and are free elsewhere.",
    }),
    path: Type.String({
      description:
        "Where to write the mesh, relative to cwd or absolute (e.g. 'assets/props/crate.glb'). " +
        "The extension is corrected to whatever container is actually delivered.",
    }),
    format: Type.Optional(
      Type.String({
        description:
          "Container: 'glb' (default) or 'obj'. Prefer glb — it is the only one that carries the " +
          "materials, so an 'obj' of a textured mesh arrives as bare geometry, and 'obj' is not produced " +
          "at all for generateType 'Geometry'. Falls back to glb whenever the provider doesn't render it.",
      }),
    ),
    // `additionalProperties`, not Type.Record: TypeBox compiles a Record to
    // `patternProperties`, which several providers' tool-schema validators
    // reject outright — and a tool whose schema is refused fails at the provider
    // with a message about JSON Schema rather than about 3D.
    axes: Type.Optional(
      Type.Object({}, {
        additionalProperties: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
        description:
          "The chosen model's own options, as {name: value} — the ONLY way to reach the options on any " +
          "model except the Hunyuan ones, since no two endpoints share their levers (one takes " +
          "`resolution`, another a `texture` ladder, another a `highPack` flag). Get the exact names and " +
          "legal values from media_capabilities with the same `model`; an option this model does not " +
          "have is REFUSED, not ignored, so do not guess. Omit an option to take the model's own " +
          "default, which for a numeric budget means letting the provider choose — on some models " +
          "setting it at all is what costs extra.",
      }),
    ),
    generateType: Type.Optional(
      Type.String({
        description:
          "Hunyuan models only (prefer `axes` elsewhere). 'Normal' ($0.375, default) — textured mesh. " +
          "'LowPoly' ($0.45) — retopologised, best for a game asset that will deform or needs clean " +
          "edges; dearer because it is more work, not less. 'Geometry' ($0.225) — untextured geometry " +
          "only, for blockouts and greyboxing.",
      }),
    ),
    polygonType: Type.Optional(
      Type.String({
        description:
          "Hunyuan models only (prefer `axes` elsewhere). 'triangle' (default) or 'quadrilateral'. Quads " +
          "deform far better under animation, so choose them for anything that will be rigged; triangles " +
          "are fine for static props.",
      }),
    ),
    faceCount: Type.Optional(
      Type.Number({
        description:
          "Target face budget, honoured exactly; the legal range is per-model (media_capabilities " +
          "reports it). On the Hunyuan models it ADDS $0.15 because the provider charges for a custom " +
          "count, and leaving it unset uses their 500k default — measured at 8.6 MB untextured and 64 MB " +
          "textured, against 15 MB for a textured 60k mesh. Free on most other models. Set it for " +
          "anything going into a game.",
      }),
    ),
    pbr: Type.Optional(
      Type.Boolean({
        description:
          "Generate PBR materials (base colour, normal, roughness/metallic) instead of a flat texture. " +
          "Essential for anything lit by a modern engine. ADDS $0.15 on the Hunyuan models and is free " +
          "on Tripo and Meshy — which is why the price comes from media_capabilities and not from here. " +
          "Refused on any model generating untextured geometry.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Which 3D model to use, e.g. 'fal-ai/hyper3d/rodin/v2.5/fast' for a cheap blockout or " +
          "'meshy/v7/image-to-3d' for a game-ready hero asset. media_capabilities lists every id with " +
          "its price. Leave unset to use the account default.",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: {
      images: string[]; path: string; format?: string; generateType?: string;
      polygonType?: string; faceCount?: number; pbr?: boolean; model?: string;
      axes?: Record<string, string | number | boolean>;
    },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const paths = params.images ?? [];
    if (paths.length === 0) return text("Error: at least one reference image is required — generate one with generate_image first.");
    if (paths.length > MAX_MESH_VIEWS) {
      return text(`Error: at most ${MAX_MESH_VIEWS} reference views (front, back, left, right); got ${paths.length}.`);
    }
    if (!params.path) return text("Error: path is required — say where to save the mesh.");

    let images: { data: string; mimeType: string }[];
    try {
      images = paths.map((p) => readInputImage(cwd, p));
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // base64 is 4 bytes per 3, so compare decoded sizes against the decoded cap.
    const totalBytes = images.reduce((sum, img) => sum + Math.floor((img.data.length * 3) / 4), 0);
    if (totalBytes > MAX_MESH_INPUT_TOTAL_BYTES) {
      return text(
        `Error: the reference views total ${(totalBytes / 1048576).toFixed(1)} MB; the limit for one request is ` +
          `${MAX_MESH_INPUT_TOTAL_BYTES / 1048576} MB. Use fewer views, or downscale them first.`,
      );
    }

    const submitted = await callAccount<ModelSubmitResponse>("/api/agent/media/models", {
      method: "POST",
      signal,
      body: {
        images,
        ...(params.format ? { format: params.format } : {}),
        // `axes` wins over the named fields server-side, so a model passing both
        // gets what it spelled out per-axis. The named four are sent alongside
        // rather than folded in here: which of them the chosen model actually
        // has is the server's business, and duplicating that judgement in the
        // tool is how the two get to disagree.
        ...(params.axes && typeof params.axes === "object" ? { axes: params.axes } : {}),
        ...(params.generateType ? { generateType: params.generateType } : {}),
        ...(params.polygonType ? { polygonType: params.polygonType } : {}),
        ...(params.faceCount != null ? { faceCount: params.faceCount } : {}),
        ...(params.pbr ? { pbr: true } : {}),
        ...(params.model ? { model: params.model } : {}),
      },
    });
    if (!submitted.ok) return text(`3D generation failed: ${submitted.message}`);
    const jobId = submitted.data.jobId;
    if (!jobId) return text("3D generation failed: Privateer did not return a job id.");

    // Poll to completion. The account is charged when the provider delivers, so an
    // abandoned poll still costs money — hence the timeout message names the job id.
    const deadline = Date.now() + MESH_POLL_TIMEOUT_MS;
    const cancelled = () =>
      text(`3D job ${jobId} was submitted but the wait was cancelled. It is still running and will still be billed.`);
    for (;;) {
      if (signal?.aborted) return cancelled();
      await sleep(MESH_POLL_INTERVAL_MS, signal);
      if (signal?.aborted) return cancelled();
      const poll = await callAccount<ModelStatusResponse>(`/api/agent/media/models/${encodeURIComponent(jobId)}`, {
        method: "GET",
        signal,
      });
      if (!poll.ok) return text(`3D job ${jobId} could not be polled: ${poll.message}`);

      const status = String(poll.data.status ?? "").toLowerCase();
      if (status === "failed") return text(`3D generation failed: ${poll.data.message ?? "the provider reported a failure"}.`);
      if (status === "completed") {
        if (!poll.data.data) {
          return text(`3D job ${jobId} already delivered its bytes on an earlier poll; they were not saved. Generate again if the file is missing.`);
        }
        // The delivered container wins over the requested one. Writing GLB bytes
        // into a path someone named `.fbx` produces a file that opens nowhere and
        // a bug report about the importer.
        const delivered = String(poll.data.format || "glb").toLowerCase();
        const target = abs(cwd, params.path);
        const asked = extname(target).replace(/^\./, "").toLowerCase();
        const out = `${target.slice(0, target.length - extname(target).length)}.${delivered}`;
        const summary = writeOut(out, Buffer.from(poll.data.data, "base64"));
        const note = asked && asked !== delivered
          ? `\n(Asked for .${asked}; the provider returned ${delivered.toUpperCase()}, so the file was saved with that extension.)`
          : "";
        return text(`Generated 3D model with ${poll.data.model ?? submitted.data.model ?? "the account 3D model"}: ${summary}${note}`);
      }
      if (Date.now() > deadline) {
        return text(
          `3D job ${jobId} is still ${status || "running"} after ${Math.round(MESH_POLL_TIMEOUT_MS / 60000)} minutes. ` +
            "It will still complete and still be billed; nothing was saved here.",
        );
      }
    }
  },
};

// ── Audio ────────────────────────────────────────────────────────────────────

interface AudioResponse {
  audioBase64?: string;
  mimeType?: string;
  model?: string;
  /** Present only for the models that take a length — an sfx model always does. */
  durationSeconds?: number;
}

export const generateSpeechToolDefinition = {
  name: "generate_speech",
  label: "Generate Speech",
  description:
    "Turn text into spoken audio and save it to disk. Use it to narrate a video you are assembling, or " +
    "to produce a spoken version of a written answer. Billed to the user's Privateer account; the " +
    "account's default voice model is a confidential-compute one, so the text is processed inside an " +
    "enclave rather than by a retaining provider. Mux the result onto video with video_compose.",
  parameters: Type.Object({
    text: Type.String({ description: "The words to speak. Write them as they should be read aloud." }),
    path: Type.String({ description: "Where to write the audio, relative to cwd or absolute (e.g. 'audio/narration.mp3')." }),
    voice: Type.Optional(Type.String({ description: "Voice name, if the account's TTS model offers a choice. Leave unset for its default." })),
    model: Type.Optional(Type.String({ description: "Override the account's text-to-speech model." })),
  }),
  async execute(
    _toolCallId: string,
    params: { text: string; path: string; voice?: string; model?: string },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const body = String(params.text ?? "").trim();
    if (!body) return text("Error: text is required.");
    if (!params.path) return text("Error: path is required — say where to save the audio.");

    const r = await callAccount<AudioResponse>("/api/audio/speech", {
      method: "POST",
      signal,
      body: {
        text: body,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.model ? { ttsModelId: params.model } : {}),
      },
    });
    if (!r.ok) return text(`Speech generation failed: ${r.message}`);
    if (!r.data.audioBase64) return text("Speech generation returned no audio.");

    const target = abs(cwd, params.path);
    const ext = extname(target) || extForMime(r.data.mimeType ?? "", ".mp3");
    const out = `${target.slice(0, target.length - extname(target).length)}${ext}`;
    return text(`Generated speech: ${writeOut(out, Buffer.from(r.data.audioBase64, "base64"))}`);
  },
};

export const generateMusicToolDefinition = {
  name: "generate_music",
  label: "Generate Music",
  description:
    "Generate an instrumental music clip from a text prompt and save it to disk — a soundtrack for a " +
    "video you are assembling. PRIVACY: music is the one media type with no zero-retention or " +
    "confidential option anywhere in the catalog, so the prompt reaches a provider that may retain it. " +
    "Privateer sends it unattributed (no account id, no history), but it is not private the way the " +
    "other media tools are. Do not put anything sensitive or personal in a music prompt, and say so if " +
    "the user's own wording would carry something identifying.",
  parameters: Type.Object({
    prompt: Type.String({ description: "The music to generate: genre, mood, instrumentation, tempo. Keep it about the music, not about the user." }),
    path: Type.String({ description: "Where to write the audio, relative to cwd or absolute (e.g. 'audio/score.mp3')." }),
    model: Type.Optional(Type.String({ description: "Override the account's music model." })),
  }),
  async execute(
    _toolCallId: string,
    params: { prompt: string; path: string; model?: string },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return text("Error: prompt is required.");
    if (!params.path) return text("Error: path is required — say where to save the audio.");

    const r = await callAccount<AudioResponse>("/api/audio/music", {
      method: "POST",
      signal,
      body: { prompt, ...(params.model ? { musicModelId: params.model } : {}) },
    });
    if (!r.ok) return text(`Music generation failed: ${r.message}`);
    if (!r.data.audioBase64) return text("Music generation returned no audio.");

    const target = abs(cwd, params.path);
    const ext = extname(target) || extForMime(r.data.mimeType ?? "", ".mp3");
    const out = `${target.slice(0, target.length - extname(target).length)}${ext}`;
    return text(
      `Generated music with ${r.data.model ?? "the account music model"}: ${writeOut(out, Buffer.from(r.data.audioBase64, "base64"))}\n` +
        "(Reminder for the answer you give the user: music prompts are sent to a provider with no zero-retention option, unattributed.)",
    );
  },
};

// ── Sound effects ────────────────────────────────────────────────────────────
//
// The server clamps a length it doesn't like (falClampDuration) rather than refusing it,
// which is the right behaviour for a UI slider and the wrong one for an agent: a model
// that asked for 45 seconds of rain and silently got 30 will cut the sequence to a length
// that doesn't exist. So the bounds are enforced HERE, by name, before the call.
const SFX_MIN_SECONDS = 1;
const SFX_MAX_SECONDS = 30;

export const generateSfxToolDefinition = {
  name: "generate_sfx",
  label: "Generate Sound Effect",
  description:
    "Generate a single sound effect from a text prompt and save it to disk — an impact, a whoosh, a UI " +
    "click, a room ambience. Cheap (about $0.01-$0.02 a call) and quick. This is for ONE sound, not for " +
    "a score: use generate_music for a bed and generate_speech for narration. Place the result in time " +
    "with video_compose's mix_audio, which is what makes an effect land on the frame it belongs to.\n" +
    "PRIVACY: every effect model is a non-zero-retention provider, so this is gated exactly like image " +
    "and video generation — an account with Require ZDR on is REFUSED until its owner enables non-ZDR " +
    "media. That is a setting only they can change, so do not retry a refusal. (Do not reach for " +
    "generate_music instead on privacy grounds: music has no ZDR gate at all, which is looser, not " +
    "safer.) Check media_capabilities if you need to know whether this account can use it before you plan " +
    "a sequence around a dozen effects.",
  parameters: Type.Object({
    prompt: Type.String({
      description:
        "The sound itself, described as a sound: 'heavy wooden door slamming shut, close mic, reverberant hall'. " +
        "Effect models are tuned for one event, so keep it to one — a scene comes out muddy.",
    }),
    path: Type.String({ description: "Where to write the audio, relative to cwd or absolute (e.g. 'audio/sfx/door-slam.mp3')." }),
    seconds: Type.Optional(
      Type.Number({
        description: `How long the effect should be, ${SFX_MIN_SECONDS}-${SFX_MAX_SECONDS} whole seconds. Defaults to 5. One of the models is billed by the second, so ask for what you need.`,
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Override the account's effect model. 'fal-ai/elevenlabs/sound-effects/v2' is the most convincing " +
          "foley in the catalog; the default is a cheaper model tuned for single sounds.",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { prompt: string; path: string; seconds?: number; model?: string },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return text("Error: prompt is required.");
    if (!params.path) return text("Error: path is required — say where to save the audio.");

    let seconds: number | undefined;
    if (params.seconds != null) {
      seconds = Number(params.seconds);
      if (!Number.isFinite(seconds) || seconds < SFX_MIN_SECONDS || seconds > SFX_MAX_SECONDS) {
        return text(
          `Error: seconds must be between ${SFX_MIN_SECONDS} and ${SFX_MAX_SECONDS} (got ${params.seconds}). ` +
            "For anything longer, generate a few effects and place them with video_compose mix_audio, or use generate_music for a bed.",
        );
      }
      // Whole seconds for every effect model in the catalog, including the two whose
      // schema would take a float: an effect is aimed at by feel, and 4.6s is a number
      // nobody chose. Rounding here keeps the reported length and the file in agreement.
      seconds = Math.round(seconds);
    }

    const r = await callAccount<AudioResponse>("/api/audio/sfx", {
      method: "POST",
      signal,
      body: {
        prompt,
        ...(seconds != null ? { duration: seconds } : {}),
        ...(params.model ? { sfxModelId: params.model } : {}),
      },
    });
    if (!r.ok) return text(`Sound-effect generation failed: ${r.message}`);
    if (!r.data.audioBase64) return text("Sound-effect generation returned no audio.");

    const target = abs(cwd, params.path);
    const ext = extname(target) || extForMime(r.data.mimeType ?? "", ".mp3");
    const out = `${target.slice(0, target.length - extname(target).length)}${ext}`;
    const length = r.data.durationSeconds ? `${r.data.durationSeconds}s ` : "";
    return text(
      `Generated a ${length}sound effect with ${r.data.model ?? "the account effect model"}: ` +
        writeOut(out, Buffer.from(r.data.audioBase64, "base64")),
    );
  },
};

// ── Capabilities ─────────────────────────────────────────────────────────────

interface CapabilitiesResponse {
  image?: { model?: string; blockedByZdr?: boolean; maxPerCall?: number };
  video?: { model?: string; blockedByZdr?: boolean; durations?: number[] | null; aspectRatios?: string[] | null };
  model3d?: {
    model?: string;
    configured?: boolean;
    blockedByZdr?: boolean;
    formats?: string[];
    /** The options THIS model takes. They differ per endpoint — see MeshAxis. */
    axes?: MeshAxis[];
    conflicts?: { whenAxis: string; is: string | number | boolean; forbids: string }[];
    /** Every 3D model the account can ask for. The agent has no picker, so this
     *  is the only place model ids other than the default can be discovered. */
    catalog?: { id: string; name?: string; priceUsd?: { min?: number; max?: number } | null }[];
    generateTypes?: string[];
    polygonTypes?: string[];
    faceCount?: { min?: number; max?: number } | null;
    maxViews?: number;
    priceUsd?: { min?: number; max?: number } | null;
  };
  /** Sound effects. `configured` is our deployment missing a fal key; `blockedByZdr` is
   *  the account's own privacy setting. They are different refusals with different
   *  remedies, and only one of them is the user's to fix. */
  sfx?: { model?: string; configured?: boolean; blockedByZdr?: boolean; maxDurationSeconds?: number };
  privacy?: { requireZdr?: boolean; allowNonZdrMedia?: boolean };
}

/**
 * One option a 3D model takes.
 *
 * The five vendors behind the catalog do not share their levers: Trellis prices
 * on `resolution`, Tripo on a texture ladder, Rodin on an addon flag, Hunyuan on
 * a generate type plus three surcharges. So the model is told what the endpoint
 * it picked actually offers rather than being given four fixed parameters that
 * are right for one row and meaningless for the other nine.
 */
interface MeshAxis {
  name: string;
  kind: "enum" | "bool" | "int" | "views";
  /** True where this choice moves the price. */
  priced?: boolean;
  default?: string | number | boolean | null;
  values?: string[] | null;
  min?: number | null;
  max?: number | null;
}

/**
 * The 3D section of the capability report.
 *
 * Exported and pure so it can be tested against a response shape without an
 * account: the whole point of these lines is that a model reads them and then
 * spends the user's money, and the failure mode — printing options that belong
 * to a different endpoint than the one it will call — costs real money and looks
 * like nothing at all.
 */
export function describeModel3d(model3d: CapabilitiesResponse["model3d"]): string[] {
  // 3D has two independent refusals — our deployment missing a provider key, and
  // the user's own privacy setting — and telling someone to change a preference
  // that isn't the problem wastes a turn each way.
  if (model3d?.configured === false) {
    return ["3D model generation: NOT AVAILABLE on this deployment (no provider key). Do not call generate_model."];
  }

  const lines = [
    `3D model: ${model3d?.model ?? "unknown"}${model3d?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
    `  formats: ${model3d?.formats?.length ? model3d.formats.join(", ") : "glb"}` +
      `; up to ${model3d?.maxViews ?? 4} reference view(s)`,
    `  cost: $${(model3d?.priceUsd?.min ?? 0).toFixed(2)}-$${(model3d?.priceUsd?.max ?? 0).toFixed(2)} charged per mesh, ` +
      "depending on the options below",
  ];

  // The options of the model being DESCRIBED, not a fixed four. Passed to
  // generate_model as `axes`, spelled exactly as printed here — an axis name this
  // model does not have is refused rather than ignored.
  if (model3d?.axes?.length) {
    lines.push(`  options (pass as generate_model's \`axes\`, e.g. {"${model3d.axes[0].name}": ...}):`);
    for (const a of model3d.axes) lines.push(describeAxis(a));
  }
  for (const c of model3d?.conflicts ?? []) {
    lines.push(`    NOTE: ${c.forbids} cannot be used when ${c.whenAxis} is ${JSON.stringify(c.is)}.`);
  }

  // Without this the agent knows one id — the account default — and the other
  // nine endpoints may as well not exist. The spread is a factor of seventeen, so
  // which one is picked matters more than any single option on it.
  if (model3d?.catalog?.length) {
    lines.push("  every 3D model available (pass `model` to generate_model, or to this tool to see its options):");
    for (const m of model3d.catalog) {
      const p = m.priceUsd ? ` $${(m.priceUsd.min ?? 0).toFixed(2)}-$${(m.priceUsd.max ?? 0).toFixed(2)}` : "";
      lines.push(`    ${m.id}${p}${m.id === model3d.model ? "  [described above]" : ""}`);
    }
  }
  return lines;
}

/** One axis as a line the model can read: name, legal values, and whether it costs. */
function describeAxis(a: MeshAxis): string {
  const cost = a.priced ? "  [affects price]" : "";
  if (a.kind === "int") return `    ${a.name}: number ${a.min ?? "?"}-${a.max ?? "?"}, omit to let the provider choose${cost}`;
  if (a.kind === "views") return `    ${a.name}: driven by how many images you pass${cost}`;
  if (a.kind === "bool") return `    ${a.name}: true | false (default ${a.default === true})${cost}`;
  return `    ${a.name}: ${(a.values ?? []).join(" | ")} (default ${String(a.default)})${cost}`;
}

/**
 * The sound-effect section of the capability report.
 *
 * Exported and pure for the same reason describeModel3d is: this is where a model
 * finds out whether an effect is worth planning for, and the two ways it can be
 * unavailable have different remedies — one is our deployment's missing key (nobody
 * on this server can generate an effect) and one is the account owner's privacy
 * setting (only they can change it). Collapsing them into "unavailable" sends the
 * user to a preference screen that isn't the problem.
 */
export function describeSfx(sfx: CapabilitiesResponse["sfx"]): string[] {
  if (sfx?.configured === false) {
    return ["Sound effects: NOT AVAILABLE on this deployment (no provider key). Do not call generate_sfx."];
  }
  if (sfx?.blockedByZdr) {
    return [
      `Sound effects: ${sfx.model ?? "unknown"}  [BLOCKED by this account's ZDR setting]`,
      "  Every effect model is non-ZDR, so this account cannot generate one until its owner enables " +
        "non-ZDR media (Settings → Privacy). Do not substitute generate_music for an effect — it is " +
        "ungated, not more private.",
    ];
  }
  return [
    `Sound effects: ${sfx?.model ?? "unknown"}`,
    `  up to ${sfx?.maxDurationSeconds ?? SFX_MAX_SECONDS}s per effect, one sound per call, ~$0.01-$0.02 each`,
  ];
}

export const mediaCapabilitiesToolDefinition = {
  name: "media_capabilities",
  label: "Media Capabilities",
  description:
    "Report what this Privateer account can generate right now: which image and video models it " +
    "resolves to, the clip lengths and aspect ratios that video model accepts, and whether the " +
    "account's privacy settings currently block media generation. Free and instant. Call it before " +
    "planning a multi-clip video so you pick a legal clip length instead of discovering it through a " +
    "rejected — or worse, billed — call.\n" +
    "It is also the ONLY way to find out which 3D models exist and what options each one takes: they " +
    "range from $0.14 to $2.41 a mesh and no two take the same options, so call this with `model` set " +
    "to the id you are considering BEFORE generate_model, or you will pay the default model's price " +
    "for a job a cheaper one could have done.",
  parameters: Type.Object({
    model: Type.Optional(
      Type.String({
        description:
          "A 3D model id to describe instead of the account default (e.g. 'fal-ai/trellis-2'). " +
          "The response's 3D catalog lists every legal id; every field reported — the options, " +
          "their legal values and the price — is per-model.",
      }),
    ),
  }),
  async execute(_toolCallId: string, params: { model?: string }, signal?: AbortSignal) {
    const query = params?.model ? `?model=${encodeURIComponent(params.model)}` : "";
    const r = await callAccount<CapabilitiesResponse>(`/api/agent/media/capabilities${query}`, { method: "GET", signal });
    if (!r.ok) return text(`Could not read media capabilities: ${r.message}`);

    const { image, video, model3d, sfx, privacy } = r.data;
    const lines = [
      `Image model: ${image?.model ?? "unknown"}${image?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
      `  up to ${image?.maxPerCall ?? 1} image(s) per call`,
      `Video model: ${video?.model ?? "unknown"}${video?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
      `  clip lengths: ${video?.durations?.length ? `${video.durations.join(", ")}s` : "model default only"}`,
      `  aspect ratios: ${video?.aspectRatios?.length ? video.aspectRatios.join(", ") : "model default only"}`,
    ];

    lines.push(...describeModel3d(model3d));
    lines.push(...describeSfx(sfx));

    lines.push(`Privacy: requireZdr=${privacy?.requireZdr ?? "?"}, allowNonZdrMedia=${privacy?.allowNonZdrMedia ?? "?"}`);
    if (image?.blockedByZdr || video?.blockedByZdr || model3d?.blockedByZdr || sfx?.blockedByZdr) {
      lines.push(
        "A [BLOCKED] model means the account requires Zero Data Retention and that model has no ZDR endpoint. " +
          "Only the account owner can change it (Settings → Privacy); do not keep retrying.",
      );
    }
    lines.push(
      "Speech and music are always available; sound effects are not (see above). Speech runs confidentially, " +
        "music has no ZDR gate at all, and effects are gated like image and video — so a blocked effect must " +
        "never be answered with music.",
    );
    return text(lines.join("\n"));
  },
};

/**
 * Extension factory registering every account-backed media tool. Used by the surfaces
 * that build their session from an explicit `extensionFactories` list (harbor, channels,
 * ACP, the REPL); the interactive TUI picks the same definitions up through
 * `extensions/privateer-media.ts`, which the launcher passes it as an `-e` argument.
 *
 * Keep this in step with MEDIA_TOOL_NAMES — tests/media.test.ts asserts the two agree,
 * because the allow-lists in harbor/channels/acp are built from the names and a tool
 * registered but unlisted would be silently ungrantable to an unattended run.
 */
export function makeMediaTools() {
  return (pi: { registerTool?: (def: unknown) => void }): void => {
    pi.registerTool?.(generateImageToolDefinition);
    pi.registerTool?.(generateVideoToolDefinition);
    pi.registerTool?.(generateModelToolDefinition);
    pi.registerTool?.(generateSpeechToolDefinition);
    pi.registerTool?.(generateMusicToolDefinition);
    pi.registerTool?.(generateSfxToolDefinition);
    pi.registerTool?.(mediaCapabilitiesToolDefinition);
  };
}

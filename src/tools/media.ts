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
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { apiRequest } from "../auth/privateer.ts";

/** Tool names these definitions register, for allow-list construction. */
export const MEDIA_TOOL_NAMES = [
  "generate_image",
  "generate_video",
  "generate_model",
  "generate_sprite",
  "generate_speech",
  "generate_music",
  "generate_sfx",
  "media_capabilities",
] as const;

// A video job can legitimately take minutes. Bound the wait so a wedged provider
// doesn't pin an unattended run forever; the job id is reported on timeout so the
// caller can resume the poll (`resumeJobId`) rather than pay for another generation.
//
// TWENTY-FIVE, AND THE RESUME PARAM, ARE ONE FIX. At twelve this was the only
// surface that gave up on a job at all — the app's own poller (ChatScreen,
// libraryService) runs on a bare setInterval with no deadline, so the identical
// job that lands fine in a chat was abandoned in a terminal — and there was
// nothing to resume WITH: `generate_video` took no job id, so the sentence above
// described a recovery the tool could not perform. The model's only move was to
// call generate_video again, which bills a second generation and starts a second
// wait, which is what "video generation hangs" looks like from the outside.
//
// The ceiling stays because an unattended run must not be pinned forever, and 25
// is not arbitrary: the desktop's turn supervisor abandons a turn whose open tool
// has been silent for 30 minutes (desktop/src/main/turnSupervisor.ts toolStallMs),
// and a tool that outlives its own supervisor is abandoned mid-poll with the job
// uncollected — exactly the failure this is fixing. Keep it under that budget.
const VIDEO_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_VIDEO_TIMEOUT_MS) || 25 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
// A mesh job runs about a minute at the provider's stated typical time, and
// several for a large face count. Same bounded-wait contract as video: the job
// id is reported on timeout so the caller can resume the poll rather than pay
// for a second generation.
const MESH_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_MESH_TIMEOUT_MS) || 10 * 60_000;
// A sprite job renders one clip per BILLED facing, so an eight-way set waits on
// five video generations rather than one. They are SUBMITTED in one pass and
// render together at the provider (spriteApiHandler submits the whole fan-out
// before returning the 202), so the wait is roughly one clip's — what is serial
// is the stage BEFORE it, where the picture is turned to face each direction one
// edit at a time. The ceiling is correspondingly generous; as with video, the job
// id is reported on timeout and `resumeJobId` is what goes back to it, so a slow
// job is never a reason to pay for a second fan-out.
const SPRITE_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_SPRITE_TIMEOUT_MS) || 25 * 60_000;
const SPRITE_POLL_INTERVAL_MS = 6_000;
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
  /**
   * The HTTP status behind the failure, or undefined when the request never got
   * an answer at all (DNS, reset, offline). A POLLER needs this and a one-shot
   * caller does not: abandoning a paid job because one poll returned 502 throws
   * the job away, while retrying a 404 or a 410 forever is just as wrong. The
   * status is the only thing that separates the two, so it is carried rather
   * than flattened into the message.
   */
  status?: number;
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
      ok: false, status: res.status,
      message:
        (serverMessage || "this account requires Zero Data Retention and the media model has no ZDR endpoint") +
        " — this is a privacy setting only the account owner can change (Settings → Privacy), so do not retry.",
    };
  }
  if (code === "ZDR_KEY_UNAVAILABLE") {
    return { ok: false, status: res.status, message: serverMessage || "no zero-retention provider key is available right now — try again later" };
  }
  if (/DAILY_CAP|LIMIT_REACHED/i.test(code) || res.status === 429) {
    return { ok: false, status: res.status, message: serverMessage || "the account's daily media allowance is used up — it resets tomorrow" };
  }
  if (res.status === 402 || /INSUFFICIENT|QUOTA|TOP_?UP/i.test(code)) {
    return { ok: false, status: res.status, message: serverMessage || "the account is out of credit for media generation — top up or upgrade to continue" };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false, status: res.status,
      message:
        serverMessage ||
        "this agent is not signed in to a Privateer account (or the plan doesn't include this), so it cannot generate media",
    };
  }
  if (res.status === 400 || res.status === 413) {
    return { ok: false, status: res.status, message: serverMessage || `Privateer rejected the request${code ? ` (${code})` : ""}` };
  }
  // 503/504 are OUR outage or a provider timing out, not a bad request: an unset
  // provider key, our own balance with that provider, or a slow job. Retrying the same
  // call later is the right move, and saying so stops a model from rewriting a perfectly
  // good prompt in the belief it caused this.
  if (res.status === 503 || res.status === 504) {
    return {
      ok: false, status: res.status,
      message: `${serverMessage || "that media service is temporarily unavailable"} — this is on Privateer's side, not the prompt's; try again in a few minutes`,
    };
  }
  return { ok: false, status: res.status, message: serverMessage || `media generation failed (HTTP ${res.status}${code ? ` ${code}` : ""})` };
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
    "media_capabilities first if unsure. Stitch the finished clips with video_compose.\n" +
    "If a call comes back saying the job is still running, DO NOT call this again with the same " +
    "prompt — that bills a second generation. Call it with `resumeJobId` set to the job id it " +
    "reported (and the same `path`) to keep waiting on the clip the account has already paid for.",
  parameters: Type.Object({
    prompt: Type.String({ description: "What happens in the shot: subject, action, camera move, style." }),
    path: Type.String({ description: "Where to write the video, relative to cwd or absolute (e.g. 'clips/01-opening.mp4')." }),
    resumeJobId: Type.Optional(Type.String({
      description:
        "Resume waiting on a job already submitted (from a previous call that timed out). " +
        "Nothing is generated and nothing is billed: it only polls and saves. `prompt` is ignored.",
    })),
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
      prompt: string; path: string; resumeJobId?: string; firstFrame?: string; lastFrame?: string;
      seconds?: number; aspectRatio?: string; resolution?: string; audio?: boolean; model?: string;
    },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    if (!params.path) return text("Error: path is required — say where to save the video.");

    // RESUME. Submit nothing, bill nothing — just go back to waiting on a job the
    // account has already paid for. Everything below the poll is identical, which
    // is why the loop lives in awaitVideoJob() rather than being duplicated here.
    const resumeJobId = String(params.resumeJobId ?? "").trim();
    if (resumeJobId) {
      return awaitVideoJob(resumeJobId, cwd, params.path, null, signal);
    }

    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return text("Error: prompt is required.");
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

    return awaitVideoJob(jobId, cwd, params.path, submitted.data.model ?? null, signal);
  },
};

/**
 * Wait on a submitted video job and write its bytes to `path`.
 *
 * Split out of execute() so the RESUME path is the same code rather than a second
 * copy of it: the bytes are delivered exactly once and are stored nowhere, so a
 * resume that polled differently from the original wait would be the one place a
 * paid clip could be dropped.
 *
 * `submittedModel` is null on a resume — we did not submit, so we have no model
 * name of our own. The poll reports one anyway; the fallback only covers a server
 * that returns neither.
 */
async function awaitVideoJob(
  jobId: string,
  cwd: string,
  path: string,
  submittedModel: string | null,
  signal?: AbortSignal,
) {
  // The account is charged when the provider delivers, so an abandoned poll still
  // costs money — every exit below names the job id, and `resumeJobId` is what
  // turns that id back into the file.
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  const resumeHint = `Resume it with generate_video { resumeJobId: "${jobId}", path: "${path}" } — that waits on this same clip and bills nothing further.`;
  const cancelled = () =>
    text(`Video job ${jobId} is still running and will still be billed; the wait was cancelled. ${resumeHint}`);
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
    // A poll that fails is NOT the job failing — the clip is still coming and is
    // still billed, so this has to point at the resume too. Without that the model
    // reads a dropped request as a dead job and generates the whole thing again.
    if (!poll.ok) return text(`Video job ${jobId} could not be polled: ${poll.message}. ${resumeHint}`);

    const status = String(poll.data.status ?? "").toLowerCase();
    if (status === "failed") return text(`Video generation failed: ${poll.data.message ?? "the provider reported a failure"}.`);
    if (status === "completed") {
      if (!poll.data.data) {
        // The bytes were handed out on an earlier poll and are not stored anywhere.
        return text(`Video job ${jobId} already delivered its bytes on an earlier poll; they were not saved. Generate again if the file is missing.`);
      }
      const target = abs(cwd, path);
      const ext = extname(target) || extForMime(poll.data.mimeType ?? "", ".mp4");
      const out = `${target.slice(0, target.length - extname(target).length)}${ext}`;
      const summary = writeOut(out, Buffer.from(poll.data.data, "base64"));
      return text(`Generated video with ${poll.data.model ?? submittedModel ?? "the account video model"}: ${summary}`);
    }
    if (Date.now() > deadline) {
      return text(
        `Video job ${jobId} is still ${status || "running"} after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 60000)} minutes. ` +
          `It will still complete and is already billed — do NOT generate it again. ${resumeHint}`,
      );
    }
  }
}

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
  /** The exact wire voice the provider actually received (post-resolution —
   *  e.g. an aura-2 override of 'jupiter' comes back as 'aura-2-jupiter-en').
   *  Absent only on models that take no voice at all. */
  voice?: string;
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
    "enclave rather than by a retaining provider. Mux the result onto video with video_compose. " +
    "Call media_capabilities first if you want to override `voice` or `model` — it lists the exact " +
    "wire voice ids for the account's current TTS model (and any model you pass it), which is not " +
    "the same as a spoken character or brand name.",
  parameters: Type.Object({
    text: Type.String({ description: "The words to speak. Write them as they should be read aloud." }),
    path: Type.String({ description: "Where to write the audio, relative to cwd or absolute (e.g. 'audio/narration.mp3')." }),
    voice: Type.Optional(Type.String({
      description:
        "Voice id, if the account's TTS model offers a choice. Leave unset for its default. These are " +
        "PROVIDER wire ids, not free text — e.g. Deepgram Aura-2 voices are 'aura-2-<name>-<lang>' " +
        "('aura-2-jupiter-en', not 'jupiter' or 'Jupiter'). Get the exact legal list for the model in " +
        "play from media_capabilities' `speech.voices` before guessing one; an unrecognised id is " +
        "refused with VOICE_UNSUPPORTED rather than silently served on a different voice.",
    })),
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
    // Report what actually ran, not what was requested — the two can differ
    // (a resolved default, a normalized voice id) and the caller has no other
    // way to find out short of listening to the file.
    const via = [r.data.model, r.data.voice].filter(Boolean).join(" / ");
    return text(
      `Generated speech${via ? ` with ${via}` : ""}: ${writeOut(out, Buffer.from(r.data.audioBase64, "base64"))}`,
    );
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

/** One priced video call shape. `resolution: null` is a call that sends none. */
export interface VideoPriceRow {
  seconds: number | null;
  resolution: string | null;
  audio: boolean;
  usd: number;
}

export interface CapabilitiesResponse {
  /** `priceUsdEach` is what one image costs the account; null when the server couldn't price it. */
  image?: { model?: string; blockedByZdr?: boolean; maxPerCall?: number; priceUsdEach?: number | null };
  /** `priceUsd`/`priceTable` are the server's RESERVATION figures — worst-case-biased, so
   *  a budget built on them can only come in under. Absent on a server older than them. */
  video?: {
    model?: string;
    blockedByZdr?: boolean;
    durations?: number[] | null;
    aspectRatios?: string[] | null;
    priceUsd?: { min?: number; max?: number } | null;
    priceTable?: VideoPriceRow[] | null;
    priceSource?: "table" | "fallback";
  };
  sprites?: {
    available?: boolean;
    directionSets?: { id: string; billedClips?: number; billedTurnStills?: number }[];
  };
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
  /** `voices` (on the described model) is populated only for models with an
   *  enumerable, closed voice set (Deepgram Aura-2, Tinfoil, fal) — pass
   *  `ttsModel` to describe one other than the account default. Empty for
   *  models whose voices aren't data this server holds (Gemini, OpenAI-shaped);
   *  guessing one there is on you. `catalog` is EVERY TTS model this account
   *  can reach, summarized — the only place other than the default to
   *  discover an id, since there is no TTS picker in this CLI. */
  speech?: {
    model?: string; blockedByZdr?: boolean; voices?: string[];
    catalog?: {
      id: string; name?: string; provider?: string;
      isZdr?: boolean; isTee?: boolean; blockedByZdr?: boolean; voiceCount?: number;
    }[];
  };
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

const usd = (n: number | undefined | null): string => `$${(n ?? 0).toFixed(2)}`;

/**
 * The image and video sections of the capability report.
 *
 * Exported and pure for the reason describeModel3d is. The prices are the point: an
 * agent planning a film used to see what a mesh or an effect cost and nothing at all
 * for a clip — the dearest call it can make — so it could neither weigh the job nor
 * set a sensible `--max-spend`. A server too old to report a price gets that said
 * plainly rather than a $0.00 that reads as free.
 */
export function describeImageVideo(image: CapabilitiesResponse["image"], video: CapabilitiesResponse["video"]): string[] {
  const imagePrice =
    typeof image?.priceUsdEach === "number" ? `, about ${usd(image.priceUsdEach)} each` : ", price not reported";
  const lines = [
    `Image model: ${image?.model ?? "unknown"}${image?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
    `  up to ${image?.maxPerCall ?? 1} image(s) per call${imagePrice}`,
    `Video model: ${video?.model ?? "unknown"}${video?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
    `  clip lengths: ${video?.durations?.length ? `${video.durations.join(", ")}s` : "model default only"}`,
    `  aspect ratios: ${video?.aspectRatios?.length ? video.aspectRatios.join(", ") : "model default only"}`,
  ];
  const table = video?.priceTable ?? [];
  if (video?.priceUsd && table.length) {
    const fallback = video.priceSource === "fallback" ? " (no price row for this model — a conservative estimate)" : "";
    lines.push(`  cost: ${usd(video.priceUsd.min)}-${usd(video.priceUsd.max)} a clip${fallback}, reserved up front and settled at the real cost`);
    // Per length at the call's default (no resolution sent, no audio): that is the
    // call an agent makes unless it asks for more, and the line it budgets from.
    const plain = table.filter((r) => r.resolution === null && !r.audio && r.seconds !== null);
    if (plain.length) lines.push(`  by length (default resolution, no audio): ${plain.map((r) => `${r.seconds}s ${usd(r.usd)}`).join(", ")}`);
    const resolutions = [...new Set(table.map((r) => r.resolution).filter((r): r is string => !!r))];
    if (resolutions.length) lines.push(`  resolution changes the price: ${resolutions.join(", ")} (pass generate_video's \`resolution\`)`);
    if (table.some((r) => r.audio)) lines.push("  audio: true costs more on this model");
  } else {
    lines.push("  cost: not reported by this server — roughly $0.10-$1 a clip, more for long or high-resolution clips");
  }
  return lines;
}

/**
 * What one call of a billed tool is expected to cost, in USD — or null when it can't
 * be priced from what the server reports. Pure over a capability report, for the
 * `--max-spend` budget (permissions/cliSpend.ts): it prices the call the model is
 * ABOUT to make from that call's own arguments, and it errs high everywhere it has
 * to choose, because a cap that under-counts is not a cap.
 */
export function quoteMediaCallUsd(tool: string, input: unknown, caps: CapabilitiesResponse): number | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const clip = (seconds: number | undefined, resolution: string | undefined, audio: boolean): number | null => {
    const table = caps.video?.priceTable ?? [];
    if (!table.length) return null;
    const exact = table.find(
      (r) => r.seconds === (seconds ?? r.seconds) && r.resolution === (resolution ?? null) && r.audio === audio,
    );
    // An exact row when the call names a legal length; otherwise the dearest row that
    // still matches what we do know — never a cheaper guess.
    if (exact && seconds !== undefined) return exact.usd;
    // `resolution: null` rows are the server's price for a call that sends none, so
    // that's the set an unspecified resolution is quoted from.
    const candidates = table.filter((r) => r.resolution === (resolution ?? null) && (audio || !r.audio));
    const pool = candidates.length ? candidates : table;
    return Math.max(...pool.map((r) => r.usd));
  };
  switch (tool) {
    case "generate_image": {
      // The report prices the ACCOUNT's image model; a call naming another one would
      // be quoted at the wrong model's rate, so it isn't quoted at all.
      if (typeof args.model === "string" && args.model) return null;
      const each = caps.image?.priceUsdEach;
      if (typeof each !== "number") return null;
      const n = Math.min(Math.max(Math.trunc(num(args.count) ?? 1), 1), caps.image?.maxPerCall ?? 4);
      return each * n;
    }
    case "generate_video":
      return clip(num(args.seconds), typeof args.resolution === "string" ? args.resolution : undefined, args.audio === true);
    case "generate_model":
      return typeof caps.model3d?.priceUsd?.max === "number" ? caps.model3d.priceUsd.max : null;
    case "generate_sprite": {
      const set = typeof args.directions === "string" ? args.directions : "one";
      const row = caps.sprites?.directionSets?.find((d) => d.id === set);
      // The sprite pipeline picks each clip's length and resolution itself, so every
      // clip is quoted at the dearest silent row.
      const silent = (caps.video?.priceTable ?? []).filter((r) => !r.audio);
      const clipUsd = silent.length ? Math.max(...silent.map((r) => r.usd)) : null;
      if (!row || clipUsd === null) return null;
      const stills = row.billedTurnStills ?? 0;
      const each = caps.image?.priceUsdEach;
      if (stills > 0 && (typeof each !== "number" || (typeof args.image_model === "string" && args.image_model))) return null;
      return clipUsd * (row.billedClips ?? 1) + stills * (each ?? 0);
    }
    case "generate_sfx":
      // No server figure; the tool's own documented ceiling for a single effect.
      return 0.02;
    default:
      // Speech and music: the server reports no price, and a guess would be a cap in
      // name only.
      return null;
  }
}

/** Read the capability report (optionally describing a specific video / 3D model). */
export async function readMediaCapabilities(
  query: { videoModel?: string; model?: string } = {},
  signal?: AbortSignal,
): Promise<{ ok: true; data: CapabilitiesResponse } | { ok: false; message: string }> {
  const q = new URLSearchParams();
  if (query.videoModel) q.set("videoModel", query.videoModel);
  if (query.model) q.set("model", query.model);
  const qs = q.toString();
  const r = await callAccount<CapabilitiesResponse>(`/api/agent/media/capabilities${qs ? `?${qs}` : ""}`, { method: "GET", signal });
  return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message };
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

/**
 * Speech, worded the same way describeSfx is: a [BLOCKED] model is the
 * account's own ZDR setting, not something retrying fixes. `voices` prints
 * only when the model publishes an enumerable set — printing all 90 of
 * Aura-2's inline is the whole point (a bare character name is not a legal
 * id on the wire), but a model with none gets no fabricated list either.
 */
export function describeSpeech(speech: CapabilitiesResponse["speech"]): string[] {
  const blocked = speech?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : "";
  const lines = [`Speech model: ${speech?.model ?? "unknown"}${blocked}`];
  if (speech?.blockedByZdr) {
    lines.push(
      "  This voice model is non-ZDR, so this account cannot use it until its owner enables non-ZDR " +
        "media (Settings → Privacy). Omit `model` to use the account's confidential-compute default " +
        "instead of retrying this one.",
    );
  }
  if (speech?.voices?.length) {
    lines.push(
      `  ${speech.voices.length} voice id(s) for this model — pass one of these EXACTLY as generate_speech's ` +
        `\`voice\`, never a guessed name: ${speech.voices.join(", ")}`,
    );
  } else {
    lines.push("  No enumerable voice list for this model; omit `voice` to use its default.");
  }
  if (speech?.catalog?.length) {
    lines.push("  every TTS model available (pass `ttsModel` to this tool to see its voices):");
    for (const m of speech.catalog) {
      const tags = [m.isTee ? "confidential" : m.isZdr ? "ZDR" : "non-ZDR", `${m.voiceCount ?? 0} voice(s)`];
      if (m.blockedByZdr) tags.push("BLOCKED");
      lines.push(
        `    ${m.id}  (${tags.join(", ")})${m.id === speech.model ? "  [described above]" : ""}`,
      );
    }
  }
  return lines;
}

export const mediaCapabilitiesToolDefinition = {
  name: "media_capabilities",
  label: "Media Capabilities",
  description:
    "Report what this Privateer account can generate right now: which image and video models it " +
    "resolves to, what an image and a clip cost, the clip lengths and aspect ratios that video model accepts, and whether the " +
    "account's privacy settings currently block media generation. Free and instant. Call it before " +
    "planning a multi-clip video so you pick a legal clip length instead of discovering it through a " +
    "rejected — or worse, billed — call.\n" +
    "It is also the ONLY way to find out which 3D models exist and what options each one takes: they " +
    "range from $0.14 to $2.41 a mesh and no two take the same options, so call this with `model` set " +
    "to the id you are considering BEFORE generate_model, or you will pay the default model's price " +
    "for a job a cheaper one could have done.\n" +
    "It is also the ONLY way to find a text-to-speech model's real voice ids — Deepgram Aura-2's are " +
    "'aura-2-<name>-<lang>', not a bare character name — so call this with `ttsModel` set BEFORE " +
    "generate_speech whenever you plan to pass `voice`.",
  parameters: Type.Object({
    model: Type.Optional(
      Type.String({
        description:
          "A 3D model id to describe instead of the account default (e.g. 'fal-ai/trellis-2'). " +
          "The response's 3D catalog lists every legal id; every field reported — the options, " +
          "their legal values and the price — is per-model.",
      }),
    ),
    videoModel: Type.Optional(
      Type.String({
        description:
          "A video model id to describe instead of the account default (e.g. 'bytedance/seedance-2.0'). " +
          "Clip lengths, aspect ratios and the price per clip are all per-model — check the one you will " +
          "pass as generate_video's `model` before you spend on it.",
      }),
    ),
    ttsModel: Type.Optional(
      Type.String({
        description:
          "A text-to-speech model id to describe instead of the account default (e.g. 'deepgram/aura-2'). " +
          "The response's `speech.voices` lists every legal voice id for THIS model — voice ids are not " +
          "shared across models.",
      }),
    ),
  }),
  async execute(_toolCallId: string, params: { model?: string; ttsModel?: string; videoModel?: string }, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (params?.model) query.set("model", params.model);
    if (params?.videoModel) query.set("videoModel", params.videoModel);
    if (params?.ttsModel) query.set("ttsModel", params.ttsModel);
    const qs = query.toString();
    const r = await callAccount<CapabilitiesResponse>(
      `/api/agent/media/capabilities${qs ? `?${qs}` : ""}`,
      { method: "GET", signal },
    );
    if (!r.ok) return text(`Could not read media capabilities: ${r.message}`);

    const { image, video, model3d, sfx, speech, privacy } = r.data;
    const lines = describeImageVideo(image, video);

    lines.push(...describeModel3d(model3d));
    lines.push(...describeSfx(sfx));
    lines.push(...describeSpeech(speech));

    lines.push(`Privacy: requireZdr=${privacy?.requireZdr ?? "?"}, allowNonZdrMedia=${privacy?.allowNonZdrMedia ?? "?"}`);
    if (image?.blockedByZdr || video?.blockedByZdr || model3d?.blockedByZdr || sfx?.blockedByZdr || speech?.blockedByZdr) {
      lines.push(
        "A [BLOCKED] model means the account requires Zero Data Retention and that model has no ZDR endpoint. " +
          "Only the account owner can change it (Settings → Privacy); do not keep retrying.",
      );
    }
    lines.push(
      "Music is always available; sound effects and (per above) speech's CURRENT model may not be. Music has " +
        "no ZDR gate at all; effects are gated like image and video, so a blocked effect must never be " +
        "answered with music instead.",
    );
    return text(lines.join("\n"));
  },
};

interface SpriteSubmitResponse {
  id?: string;
  status?: string;
  billed_facings?: number;
  mirrored_facings?: number;
  animations?: number;
  message?: string;
}

interface SpriteStatusResponse {
  id?: string;
  status?: string;
  zip_base64?: string;
  bytes?: number;
  sheet?: { width: number; height: number; columns: number; rows: number; frame_width: number; frame_height: number };
  animations?: { name: string; direction: string; origin: string }[];
  res_path?: string;
  key_residue?: number;
  error?: { message?: string };
  message?: string;
}

/**
 * Is `target` the directory `root` itself, or something inside it?
 *
 * Asked through `relative` rather than by comparing string prefixes, because
 * the obvious `target.startsWith(root + "/")` is WRONG for the one root whose
 * own spelling already ends in a separator: with root `/`, every entry in a
 * perfectly ordinary archive resolves to `/thing` and matches no prefix `//`,
 * so a bundle destined for the filesystem root was rejected entry-by-entry as
 * an escape attempt. That is not a hypothetical — an agent whose cwd is `/`
 * (an Electron app opened from the Finder, a daemon started by launchd) and a
 * `dir` of `.` lands exactly there, and the sprite bundle it had already paid
 * for was thrown away with a security error that named the wrong problem. The
 * prefix form is also separator-blind on Windows.
 */
export function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/**
 * Turn one archive entry name into a path under `root`, or refuse it.
 *
 * Separators are normalised first so a `..\\..` written the Windows way is
 * judged as the traversal it is on every platform. The refusal names the
 * destination as well as the entry, because the entry name alone is the half
 * the reader already has: it is WHERE the archive was being unpacked to that
 * says whether the bundle or the caller's `dir` is the thing at fault.
 */
function archiveEntryPath(name: string, root: string): string {
  const rel = name.split("\\").join("/");
  const traverses =
    rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").some((seg) => seg === "..");
  if (traverses || !pathInside(root, resolve(root, rel))) {
    throw new Error(`archive entry "${name}" escapes the destination directory ${root}`);
  }
  return rel;
}

/**
 * Unpack the bundle into a directory.
 *
 * A hand-rolled reader rather than a dependency, and it is about thirty lines
 * because the archive is STORED — Privateer writes no compressed entries (the
 * payload is already PNG, so deflating it twice buys nothing), which means every
 * entry is a header followed by its bytes verbatim.
 *
 * ZIP-SLIP: entry names come off the wire, so each one is checked to be a plain
 * relative path landing inside the destination before anything is written. A
 * `..` segment here would let a generated archive write anywhere the agent can
 * reach, which on an unattended run is the user's whole machine.
 */
export function extractStoredZip(zip: Buffer, destDir: string): string[] {
  const written: string[] = [];
  const root = resolve(destDir);
  let at = 0;

  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const extraLen = zip.readUInt16LE(at + 28);
    const name = zip.toString("utf8", at + 30, at + 30 + nameLen);
    const dataAt = at + 30 + nameLen + extraLen;

    if (method !== 0) throw new Error(`archive entry "${name}" is compressed; only stored entries are expected`);
    if (dataAt + size > zip.length) throw new Error(`archive entry "${name}" is truncated`);

    const target = resolve(root, archiveEntryPath(name, root));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, zip.subarray(dataAt, dataAt + size));
    written.push(name);

    at = dataAt + size;
  }

  if (!written.length) throw new Error("the archive contained no files");
  return written;
}

/**
 * Guess the res:// path from where the files are being written.
 *
 * The .tres refers to its sheet by an absolute res:// path, so getting it wrong
 * means the caller opens Godot and edits a line by hand. In the overwhelmingly
 * common case the agent is running AT the project root, so the directory
 * relative to cwd IS the res:// path — deriving it is right far more often than
 * a fixed default would be. Returns undefined when the target is outside cwd,
 * where the guess would be worse than letting the server default.
 */
export function guessResPath(cwd: string, dir: string): string | undefined {
  const target = resolve(abs(cwd, dir));
  const root = resolve(cwd);
  if (target === root || !pathInside(root, target)) return undefined;
  return `res://${relative(root, target).split("\\").join("/")}/`;
}

/**
 * The direction sets the server actually recognises, with what each one yields
 * and what it bills.
 *
 * Kept here as a table rather than trusted to the description, because the
 * server does not reject an unknown set — `parseSpec` falls back to 'one'. So
 * `directions: "4"`, `"four-way"` or `"down,left,right,up"` used to be accepted
 * all the way through, bill one clip, and hand back a single-facing sheet with
 * no error anywhere: the caller asked for a four-way walk cycle and got one
 * animation, which reads as the feature being broken rather than the argument
 * being wrong. The schema is a closed set now and this table is what the
 * unpacked result is checked against.
 */
const SPRITE_DIRECTION_SETS = {
  one: { animations: 1, billed: 1 },
  four: { animations: 4, billed: 3 },
  eight: { animations: 8, billed: 5 },
} as const;
type SpriteDirections = keyof typeof SPRITE_DIRECTION_SETS;

/**
 * Whether a failed poll is worth another try.
 *
 * A poll that fails is NOT the job failing — the clips are still rendering at
 * the provider and are still being paid for. A transport error (no status at
 * all), a 429 or any 5xx is our side or the network having a bad moment, and the
 * next poll six seconds later will very likely work; abandoning the job on the
 * first one throws away up to five video generations the account has already
 * been charged for, and on this path the bundle is delivered ONCE and stored
 * nowhere, so there is nothing to go back for. A 404/410/401/402 is the
 * opposite: the job is gone, already delivered, or was never ours, and waiting
 * changes nothing.
 */
export function spritePollWorthRetrying(status?: number): boolean {
  return status === undefined || status === 429 || status >= 500;
}

// How many consecutive failed polls to ride out before giving up. Six seconds
// apart, so this is a minute of Privateer being unreachable — long enough to
// cover a deploy or a blip, short enough that a genuinely dead endpoint does not
// hold an unattended run until the 25-minute ceiling.
const SPRITE_POLL_FAILURE_BUDGET = 10;

/**
 * Put the delivered archive somewhere safe before unpacking it.
 *
 * Returns the path, or null if even this failed — in which case the caller is
 * out of options and has to say so. Deliberately the temp directory rather than
 * the destination: the destination is the thing that may be unwritable or wrong,
 * and a stray .zip inside a Godot project gets picked up by the import scan.
 */
function stashBundle(bundle: Buffer, jobId: string): string | null {
  try {
    const path = join(tmpdir(), `privateer-sprite-${jobId.replace(/[^A-Za-z0-9_-]/g, "")}.zip`);
    writeFileSync(path, bundle);
    return path;
  } catch {
    return null;
  }
}

/**
 * Wait on a submitted sprite job, unpack the bundle, and describe what landed.
 *
 * Split out of `execute` for the reason `awaitVideoJob` is: `resumeJobId` has to
 * poll EXACTLY as the original call did, and a resume that polled differently
 * would be the one path nobody exercises until someone's five-clip job is on the
 * line.
 *
 * `expectedAnimations` is the size of the direction set that was asked for, and
 * is null on a resume (where the request that chose it is gone). When it is
 * known it is checked against what actually came back — the server packs a sheet
 * out of whatever facings rendered and silently drops the rest, so a four-way
 * set whose "up" clip failed returns three animations, bills three, and says
 * nothing. That sheet is not the one the caller asked for and the .tres does not
 * contain the animation their GDScript will play.
 */
async function awaitSpriteJob(
  jobId: string,
  cwd: string,
  dir: string,
  expectedAnimations: number | null,
  billed: number | null,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + SPRITE_POLL_TIMEOUT_MS;
  // The clips are charged as they land, so an abandoned poll still costs money —
  // hence every exit below names the job id and says how to get back to it
  // without paying twice.
  const resumeHint =
    `Resume it with generate_sprite { resumeJobId: "${jobId}", dir: "${dir}" } — ` +
    "that waits on this same job and bills nothing further.";
  const cancelled = () =>
    text(
      `Sprite job ${jobId} was submitted but the wait was cancelled. Its ${billed ?? "queued"} clip(s) are still rendering and will still be billed. ` +
        resumeHint,
    );

  let consecutiveFailures = 0;

  for (;;) {
    if (signal?.aborted) return cancelled();
    await sleep(SPRITE_POLL_INTERVAL_MS, signal);
    if (signal?.aborted) return cancelled();

    const poll = await callAccount<SpriteStatusResponse>(
      `/api/agent/media/sprites/${encodeURIComponent(jobId)}`,
      { method: "GET", signal },
    );
    if (!poll.ok) {
      if (!spritePollWorthRetrying(poll.status)) {
        return text(`Sprite job ${jobId} could not be polled: ${poll.message}`);
      }
      if (++consecutiveFailures >= SPRITE_POLL_FAILURE_BUDGET || Date.now() > deadline) {
        return text(
          `Sprite job ${jobId} could not be polled ${consecutiveFailures} times in a row: ${poll.message}. ` +
            `The clips are still rendering and are still billed. ${resumeHint}`,
        );
      }
      continue;
    }
    consecutiveFailures = 0;

    const status = String(poll.data.status ?? "").toLowerCase();
    if (status === "failed") {
      return text(`Sprite generation failed: ${poll.data.error?.message ?? poll.data.message ?? "the provider reported a failure"}.`);
    }
    if (status === "completed") {
      if (!poll.data.zip_base64) {
        return text(`Sprite job ${jobId} already delivered its bytes on an earlier poll; they were not saved. Generate again if the files are missing.`);
      }
      const destination = abs(cwd, dir);
      const bundle = Buffer.from(poll.data.zip_base64, "base64");
      // Keep the bytes BEFORE touching them. This poll is the only delivery the
      // job will ever make — the server stores nothing for the agent path and
      // the next poll answers "already delivered" — so anything that throws
      // between here and the last writeFileSync used to destroy up to five
      // billed clips with no way back. The copy costs a few hundred kilobytes
      // in the temp directory and is removed the moment the unpack succeeds.
      const stash = stashBundle(bundle, jobId);
      let written: string[];
      try {
        written = extractStoredZip(bundle, destination);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return text(
          `Sprite job ${jobId} rendered but the bundle could not be unpacked into ${destination}: ${why}. ` +
            (stash
              ? `The archive itself was saved to ${stash} — unzip it there; the clips are already paid for and will not be delivered again.`
              : "The archive could not be saved either, so the clips are lost."),
        );
      }
      if (stash) {
        try {
          unlinkSync(stash);
        } catch {
          // Cleaning up a copy nobody needs is not worth failing a good unpack over.
        }
      }

      const tres = written.find((f) => f.endsWith(".tres"));
      const anims = poll.data.animations ?? [];
      const mirrored = anims.filter((a) => a.origin === "mirrored").length;
      const sheet = poll.data.sheet;
      const missing = expectedAnimations != null ? expectedAnimations - anims.length : 0;

      const lines = [
        `Generated sprite animation: ${written.length} files in ${destination}`,
        sheet ? `Sheet ${sheet.width}x${sheet.height}px, ${sheet.frame_width}x${sheet.frame_height} cells, ${sheet.columns}x${sheet.rows} grid.` : "",
        anims.length ? `Animations: ${anims.map((a) => a.name).join(", ")}${mirrored ? ` (${mirrored} mirrored, not billed)` : ""}.` : "",
        // Said out loud rather than left to be counted: a sheet short a facing is
        // not the sheet that was asked for, and the animation GDScript plays for
        // that direction is simply not in the resource.
        missing > 0
          ? `WARNING: ${missing} of ${expectedAnimations} facings did not render and are NOT in the sheet or the .tres — playing them will fail in Godot. ` +
            "The facings that did land were billed. Re-run to try for the missing ones."
          : "",
        tres ? `Set an AnimatedSprite2D's Sprite Frames to ${poll.data.res_path ?? "res://"}${tres.split("/").pop()}.` : "",
        "Set the sheet's texture Filter to Nearest in the Import dock, or the pixel art imports blurry.",
        // Surfaced rather than swallowed: the flat backdrop the clip was asked
        // for is a prompt the model can ignore, and when it does the key leaves
        // a rim. The caller can see it here instead of finding it in-game.
        poll.data.key_residue != null && poll.data.key_residue > 0.08
          ? `NOTE: the background did not key cleanly (residue ${poll.data.key_residue.toFixed(2)}) — the frames may have a fringe. Re-run, or clean them up before shipping.`
          : "",
      ].filter(Boolean);
      return text(lines.join("\n"));
    }
    if (Date.now() > deadline) {
      return text(
        `Sprite job ${jobId} is still ${status || "running"} after ${Math.round(SPRITE_POLL_TIMEOUT_MS / 60000)} minutes. ` +
          `It will still complete and still be billed; nothing was saved here. ${resumeHint}`,
      );
    }
  }
}

export const generateSpriteToolDefinition = {
  name: "generate_sprite",
  label: "Generate Sprite Animation",
  description:
    "Generate a 2D SPRITE ANIMATION for a game engine — a packed sprite sheet, the individual frame " +
    "PNGs, and a Godot 4 SpriteFrames .tres resource — from ONE picture of a character plus a " +
    "description of how it moves. The files are written straight into your project directory, so an " +
    "AnimatedSprite2D can use them without any further conversion. There is no text-to-sprite here: " +
    "generate or find the character art first (generate_image works), look at it, and pass that path " +
    "as `image` — every facing is derived from that one picture, which is what stops the character " +
    "changing between frames.\n" +
    "HOW IT IS BILLED, because it is not one generation: the motion is rendered as a short video per " +
    "FACING and then sampled into frames. `directions: 'one'` costs one video generation, 'four' " +
    "costs THREE, and 'eight' costs FIVE — the left-facing animations are mirrored from the " +
    "right-facing ones rather than rendered, which is why eight animations cost five clips and not " +
    "eight. Each clip is charged at the account's video rate, so an eight-way set is genuinely " +
    "expensive; say the total to the user before batching characters.\n" +
    "TWO models are involved, which matters when one of them is down AND when you are quoting a " +
    "price: an IMAGE model turns the picture to face each direction (only for `directions` 'four' " +
    "and 'eight'), then a VIDEO model renders the motion per facing. `image_model` and `model` " +
    "override them separately. The turns are billed too, at the image rate — one still per billed " +
    "facing after the first, so 'four' draws two and 'eight' draws four. They are small beside a " +
    "clip, but a total that counts only clips is short; media_capabilities reports both numbers " +
    "per direction set (`billedClips` and `billedTurnStills`).\n" +
    "It takes several minutes — the picture is turned to face each direction one at a time before " +
    "anything is billed, then the clips render together — and this tool waits. Frame count, cell " +
    "size and frame rate are chosen here and cost nothing extra.\n" +
    "If a call comes back saying the job is still running, or that it could not be polled, DO NOT " +
    "call this again with the same image and prompt — that bills a whole second fan-out. Call it " +
    "with `resumeJobId` set to the job id it reported (and the same `dir`) to keep waiting on the " +
    "clips the account has already paid for.\n" +
    "AVAILABILITY: this needs a video decoder on the Privateer API and some deployments do not have " +
    "one — call media_capabilities and check `sprites.available` before spending, or you will get a " +
    "clear refusal instead of a sheet. " +
    "PRIVACY: video and image models have no zero-retention option, so this is gated the way 3D is — " +
    "a ZDR account must have enabled non-ZDR media.",
  parameters: Type.Object({
    image: Type.String({
      description:
        "Path to ONE picture of the character, ideally full-body, centred and facing the viewer. " +
        "Every other facing is generated as an edit of this image, so its framing sets the framing of " +
        "the whole sheet.",
    }),
    prompt: Type.String({
      description:
        "How the character MOVES, not what it looks like — 'walking at a steady pace', 'swinging a " +
        "sword overhead', 'idle, breathing'. The appearance comes from `image`; describing it again " +
        "here only competes with the picture.",
    }),
    dir: Type.String({
      description:
        "Directory to write the sheet, frames and .tres into, relative to cwd or absolute " +
        "(e.g. 'sprites/knight'). It is created if missing. When it sits inside cwd, the res:// path " +
        "baked into the .tres is derived from it, so running at your Godot project root means the " +
        "resource resolves with nothing to edit.",
    }),
    resumeJobId: Type.Optional(Type.String({
      description:
        "Resume waiting on a job already submitted (from a previous call that timed out or lost its " +
        "poll). Nothing is generated and nothing is billed: it only polls and unpacks. `image`, " +
        "`prompt` and every other setting are ignored — pass the same `dir`.",
    })),
    action: Type.Optional(
      Type.String({
        description:
          "The animation-name stem, e.g. 'walk' — GDScript will play \"walk_down\", \"walk_left\" and so " +
          "on. Defaults to 'anim'. Keep it lowercase and ASCII; it ends up in game code.",
      }),
    ),
    directions: Type.Optional(
      Type.Union(
        [Type.Literal("one"), Type.Literal("four"), Type.Literal("eight")],
        {
          description:
            "'one' (default, one animation, ONE clip billed), 'four' (down/right/up/left, THREE billed) " +
            "or 'eight' (adds the diagonals, FIVE billed). Four is the usual choice for a top-down or " +
            "2.5D character; eight only if the game actually turns that finely. These three words are " +
            "the only accepted values — not '4', not 'four-way'.",
        },
      ),
    ),
    frames: Type.Optional(
      Type.Number({
        description:
          "Frames per animation, 2-24 (default 8). Sampled out of the rendered clip, so this costs " +
          "nothing extra and can be chosen for the look: 8 is a classic walk cycle, 12+ is smoother " +
          "and makes a larger sheet.",
      }),
    ),
    frame_size: Type.Optional(
      Type.Number({
        description:
          "Cell size in pixels, 8-512 (default 64). Frames are downscaled with nearest-neighbour, so " +
          "pixel art stays crisp. Pick the size the game actually draws at.",
      }),
    ),
    fps: Type.Optional(
      Type.Number({ description: "Playback rate written into the resource, 1-120 (default 12)." }),
    ),
    loop: Type.Optional(
      Type.Boolean({ description: "Whether the animations loop (default true)." }),
    ),
    name: Type.Optional(
      Type.String({ description: "Name for the sprite; sets the file names. Defaults to `action`." }),
    ),
    res_path: Type.Optional(
      Type.String({
        description:
          "Override the res:// folder the .tres points at, e.g. 'res://art/mobs/'. Only needed when " +
          "`dir` is not inside your Godot project root — otherwise it is derived from `dir`.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Video model id to render the motion with. Omit for the account default." }),
    ),
    image_model: Type.Optional(
      Type.String({
        description:
          "Image model id used to TURN the picture to face each direction, e.g. " +
          "'google/gemini-3.1-flash-image'. Omit for the account default. Only used when " +
          "`directions` is 'four' or 'eight' — 'one' renders no turns and never touches an image " +
          "model. Worth setting when a run fails with SPRITE_IMAGE_MODEL_UNAVAILABLE: that is the " +
          "image provider being down, not the request being wrong, and naming another model here " +
          "retries the whole run for nothing (the turns are drawn before any clip is billed). " +
          "media_capabilities lists the account's current image model.",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: {
      image: string; prompt: string; dir: string; resumeJobId?: string; action?: string; directions?: string;
      frames?: number; frame_size?: number; fps?: number; loop?: boolean;
      name?: string; res_path?: string; model?: string; image_model?: string;
    },
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    if (!params.dir) return text("Error: dir is required — say where to write the sheet and the .tres.");

    // RESUME. Submit nothing, bill nothing — just go back to waiting on a fan-out
    // the account has already paid for. The direction set that chose the facing
    // count is gone with the original request, so the short-sheet check is off.
    const resumeJobId = String(params.resumeJobId ?? "").trim();
    if (resumeJobId) return awaitSpriteJob(resumeJobId, cwd, params.dir, null, null, signal);

    if (!params.image) return text("Error: image is required — sprite generation derives every facing from one picture.");
    if (!params.prompt?.trim()) return text("Error: prompt is required — describe how the character moves.");

    // Checked rather than passed through: the server CLAMPS a number out of range
    // and falls back on an unknown direction set, both silently, so a typo comes
    // back as a sheet that is quietly not the one that was asked for — after the
    // clips are billed. Refusing costs nothing and names the fix.
    const directions = (params.directions ?? "one") as SpriteDirections;
    if (!Object.prototype.hasOwnProperty.call(SPRITE_DIRECTION_SETS, directions)) {
      return text(`Error: directions must be 'one', 'four' or 'eight' — got ${JSON.stringify(params.directions)}.`);
    }
    const ranges: [string, number | undefined, number, number][] = [
      ["frames", params.frames, 2, 24],
      ["frame_size", params.frame_size, 8, 512],
      ["fps", params.fps, 1, 120],
    ];
    for (const [label, value, min, max] of ranges) {
      if (value == null) continue;
      if (!Number.isFinite(value) || value < min || value > max) {
        return text(`Error: ${label} must be between ${min} and ${max} — got ${value}.`);
      }
    }

    let seed: { data: string; mimeType: string };
    try {
      seed = readInputImage(cwd, params.image);
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const submitted = await callAccount<SpriteSubmitResponse>("/api/agent/media/sprites", {
      method: "POST",
      signal,
      body: {
        image: seed.data,
        prompt: params.prompt,
        ...(params.action ? { action: params.action } : {}),
        ...(params.name ? { name: params.name } : {}),
        directions,
        ...(params.frames != null ? { frames: params.frames } : {}),
        ...(params.frame_size != null ? { frame_size: params.frame_size } : {}),
        ...(params.fps != null ? { fps: params.fps } : {}),
        ...(params.loop != null ? { loop: params.loop } : {}),
        // The caller's own res:// wins; otherwise derive it from where the files
        // are going, which is right whenever the agent runs at the project root.
        ...(params.res_path
          ? { res_path: params.res_path }
          : (() => {
            const guessed = guessResPath(cwd, params.dir);
            return guessed ? { res_path: guessed } : {};
          })()),
        ...(params.model ? { model: params.model } : {}),
        ...(params.image_model ? { image_model: params.image_model } : {}),
      },
    });
    if (!submitted.ok) return text(`Sprite generation failed: ${submitted.message}`);
    const jobId = submitted.data.id;
    if (!jobId) return text("Sprite generation failed: Privateer did not return a job id.");

    // The server's own count where it gave one, the table's where it did not —
    // the point of the check is to notice a SHORT sheet, so guessing high would
    // invent a failure and guessing low would hide one.
    const expected = submitted.data.animations ?? SPRITE_DIRECTION_SETS[directions].animations;
    return awaitSpriteJob(jobId, cwd, params.dir, expected, submitted.data.billed_facings ?? null, signal);
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
    pi.registerTool?.(generateSpriteToolDefinition);
    pi.registerTool?.(generateSpeechToolDefinition);
    pi.registerTool?.(generateMusicToolDefinition);
    pi.registerTool?.(generateSfxToolDefinition);
    pi.registerTool?.(mediaCapabilitiesToolDefinition);
  };
}

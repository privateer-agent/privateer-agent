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
  "generate_speech",
  "generate_music",
  "media_capabilities",
] as const;

// A video job can legitimately take minutes. Bound the wait so a wedged provider
// doesn't pin an unattended run forever; the job id is reported on timeout so the
// caller can resume the poll rather than pay for another generation.
const VIDEO_POLL_TIMEOUT_MS = Number(process.env.PRIVATEER_VIDEO_TIMEOUT_MS) || 12 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
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

// ── Audio ────────────────────────────────────────────────────────────────────

interface AudioResponse {
  audioBase64?: string;
  mimeType?: string;
  model?: string;
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

// ── Capabilities ─────────────────────────────────────────────────────────────

interface CapabilitiesResponse {
  image?: { model?: string; blockedByZdr?: boolean; maxPerCall?: number };
  video?: { model?: string; blockedByZdr?: boolean; durations?: number[] | null; aspectRatios?: string[] | null };
  privacy?: { requireZdr?: boolean; allowNonZdrMedia?: boolean };
}

export const mediaCapabilitiesToolDefinition = {
  name: "media_capabilities",
  label: "Media Capabilities",
  description:
    "Report what this Privateer account can generate right now: which image and video models it " +
    "resolves to, the clip lengths and aspect ratios that video model accepts, and whether the " +
    "account's privacy settings currently block media generation. Free and instant. Call it before " +
    "planning a multi-clip video so you pick a legal clip length instead of discovering it through a " +
    "rejected — or worse, billed — call.",
  parameters: Type.Object({}),
  async execute(_toolCallId: string, _params: unknown, signal?: AbortSignal) {
    const r = await callAccount<CapabilitiesResponse>("/api/agent/media/capabilities", { method: "GET", signal });
    if (!r.ok) return text(`Could not read media capabilities: ${r.message}`);

    const { image, video, privacy } = r.data;
    const lines = [
      `Image model: ${image?.model ?? "unknown"}${image?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
      `  up to ${image?.maxPerCall ?? 1} image(s) per call`,
      `Video model: ${video?.model ?? "unknown"}${video?.blockedByZdr ? "  [BLOCKED by this account's ZDR setting]" : ""}`,
      `  clip lengths: ${video?.durations?.length ? `${video.durations.join(", ")}s` : "model default only"}`,
      `  aspect ratios: ${video?.aspectRatios?.length ? video.aspectRatios.join(", ") : "model default only"}`,
      `Privacy: requireZdr=${privacy?.requireZdr ?? "?"}, allowNonZdrMedia=${privacy?.allowNonZdrMedia ?? "?"}`,
    ];
    if (image?.blockedByZdr || video?.blockedByZdr) {
      lines.push(
        "A [BLOCKED] model means the account requires Zero Data Retention and that model has no ZDR endpoint. " +
          "Only the account owner can change it (Settings → Privacy); do not keep retrying.",
      );
    }
    lines.push("Speech and music are always available (speech runs confidentially; music has no ZDR option — see generate_music).");
    return text(lines.join("\n"));
  },
};

/**
 * Extension factory registering all five media tools. Used by the surfaces that build
 * their session from an explicit `extensionFactories` list (harbor, channels, ACP, the
 * REPL); the interactive TUI picks the same definitions up through
 * `extensions/privateer-media.ts`, which the launcher passes it as an `-e` argument.
 */
export function makeMediaTools() {
  return (pi: { registerTool?: (def: unknown) => void }): void => {
    pi.registerTool?.(generateImageToolDefinition);
    pi.registerTool?.(generateVideoToolDefinition);
    pi.registerTool?.(generateSpeechToolDefinition);
    pi.registerTool?.(generateMusicToolDefinition);
    pi.registerTool?.(mediaCapabilitiesToolDefinition);
  };
}

// `video_compose` — the local half of media work: stitching, trimming, muxing and
// sampling video and audio files on this machine with ffmpeg.
//
// WHY A TOOL AND NOT JUST BASH. The agent can already shell out, and on an interactive
// terminal it sometimes should. But the three surfaces that matter most for media
// workflows — the harbor's unattended runs, channels, and any remote-driven turn — run
// with a read-only builtin set where `bash` is deliberately absent, and a model writing
// its own filter_complex is exactly the kind of thing that fails silently at 3am with a
// half-written file and a burnt video budget. So the operations a media workflow
// actually needs are named, validated, and composed here: the model picks an operation,
// not an ffmpeg incantation.
//
// EVERYTHING IS LOCAL. No network, no account, no billing. The generated clips came
// from generate_video and the stills from generate_image; this is what turns them into
// something finished. ffmpeg is spawned WITHOUT a shell and every argument is built
// from validated parameters, so nothing a prompt injects can become a command.
//
// ffmpeg is not a dependency we ship. When it's missing every operation says so once,
// clearly, with the install line for the platform — rather than surfacing ENOENT.

import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Tool names this module registers, for allow-list construction. */
export const COMPOSE_TOOL_NAMES = ["video_compose"] as const;

// A long concat of 1080p clips is genuinely slow; a stuck ffmpeg is not. Bound it.
const FFMPEG_TIMEOUT_MS = Number(process.env.PRIVATEER_FFMPEG_TIMEOUT_MS) || 10 * 60_000;
// Only the tail of stderr is useful (ffmpeg's banner is noise) and the whole thing
// would eat the model's context.
const STDERR_TAIL_CHARS = 1200;

const OPERATIONS = ["probe", "concat", "slideshow", "mux_audio", "trim", "extract_frame", "gif"] as const;
type Operation = (typeof OPERATIONS)[number];

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

function ffmpegBin(): string {
  return process.env.PRIVATEER_FFMPEG || "ffmpeg";
}
function ffprobeBin(): string {
  return process.env.PRIVATEER_FFPROBE || "ffprobe";
}

const INSTALL_HINT =
  process.platform === "darwin"
    ? "install it with `brew install ffmpeg`"
    : process.platform === "win32"
      ? "install it with `winget install Gyan.FFmpeg`"
      : "install it with your package manager (e.g. `sudo apt install ffmpeg`)";

class ToolError extends Error {}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Spawn a binary with an ARGUMENT ARRAY — never a shell string. Every caller below
// builds its args from validated numbers and resolved paths, so there is no point at
// which prompt-supplied text is parsed as a command.
function run(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return rejectPromise(e);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        settled = true;
        rejectPromise(new ToolError(`${bin} timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s`));
      }
    }, FFMPEG_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      // Keep only the tail while running so a chatty encode can't grow unbounded.
      if (stderr.length > STDERR_TAIL_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_CHARS * 2);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (err.code === "ENOENT") {
        rejectPromise(new ToolError(`ffmpeg is not installed (or not on PATH) — ${INSTALL_HINT}. Set PRIVATEER_FFMPEG to point at a specific binary.`));
      } else {
        rejectPromise(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  // `-nostdin` matters: without it a failing ffmpeg can block reading the terminal.
  const res = await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", ...args], signal);
  if (res.code !== 0) {
    throw new ToolError(`ffmpeg failed (exit ${res.code}):\n${res.stderr.slice(-STDERR_TAIL_CHARS).trim()}`);
  }
}

interface MediaInfo {
  path: string;
  durationSec: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number | null;
}

async function probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const res = await run(
    ffprobeBin(),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    signal,
  );
  if (res.code !== 0) {
    throw new ToolError(`could not read ${path}: ${res.stderr.slice(-400).trim() || `ffprobe exit ${res.code}`}`);
  }
  let parsed: {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string }[];
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new ToolError(`could not parse media info for ${path}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  // avg_frame_rate arrives as "30000/1001"; a still image reports "0/0".
  let fps: number | null = null;
  if (video?.avg_frame_rate && video.avg_frame_rate !== "0/0") {
    const [num, den] = video.avg_frame_rate.split("/").map(Number);
    if (num > 0 && den > 0) fps = num / den;
  }
  return {
    path,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: !!video,
    hasAudio: !!audio,
    fps,
  };
}

function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function requireExisting(cwd: string, p: string, label: string): string {
  const target = absPath(cwd, p);
  if (!existsSync(target)) throw new ToolError(`${label} not found: ${p}`);
  if (statSync(target).isDirectory()) throw new ToolError(`${label} is a directory, not a file: ${p}`);
  return target;
}

function prepareOutput(cwd: string, p: string | undefined, operation: string): string {
  if (!p) throw new ToolError(`\`output\` is required for the ${operation} operation.`);
  const target = absPath(cwd, p);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

// H.264 + yuv420p + faststart: the combination that plays everywhere, including in
// the app's own preview and in a browser. Anything else is a support ticket.
const VIDEO_ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

// ffmpeg's H.264 encoder needs even dimensions; a 9:16 crop off an odd-sized still is
// the usual way to trip it.
function evenSize(w: number, h: number): [number, number] {
  return [Math.max(2, w - (w % 2)), Math.max(2, h - (h % 2))];
}

function parseSize(size: string | undefined): [number, number] | null {
  if (!size) return null;
  const m = /^(\d{2,5})\s*[x×:]\s*(\d{2,5})$/i.exec(size.trim());
  if (!m) throw new ToolError(`\`size\` must look like 1920x1080 (got "${size}")`);
  return evenSize(Number(m[1]), Number(m[2]));
}

// Normalize one input stream to the target grid: fit inside it, pad the rest, fix the
// sample aspect ratio and frame rate. Clips from different models really do come back
// at different sizes and frame rates, and concatenating those unnormalized produces
// either a hard failure or a video that plays at the wrong speed after the first cut.
function normalizeVideo(index: number, label: string, w: number, h: number, fps: number): string {
  return (
    `[${index}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[${label}]`
  );
}

function normalizeAudio(index: number, label: string): string {
  return `[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=async=1[${label}]`;
}

// ── Operations ───────────────────────────────────────────────────────────────

interface Params {
  operation: Operation;
  inputs?: string[];
  input?: string;
  audio?: string;
  output?: string;
  size?: string;
  fps?: number;
  secondsPerImage?: number;
  crossfadeSeconds?: number;
  start?: number;
  duration?: number;
  at?: number | string;
  volume?: number;
  loopAudio?: boolean;
  keepOriginalAudio?: boolean;
}

async function opProbe(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  const list = p.inputs?.length ? p.inputs : p.input ? [p.input] : [];
  if (list.length === 0) throw new ToolError("`probe` needs `input` (or `inputs`).");
  const infos = await Promise.all(list.map((f) => probe(requireExisting(cwd, f, "input"), signal)));
  return infos
    .map((i, n) => {
      const dims = i.width && i.height ? `${i.width}x${i.height}` : "no video";
      const fps = i.fps ? `, ${i.fps.toFixed(2)} fps` : "";
      return `${list[n]}: ${i.durationSec.toFixed(2)}s, ${dims}${fps}, audio: ${i.hasAudio ? "yes" : "no"}`;
    })
    .join("\n");
}

// Stitch clips end to end, optionally with a crossfade between them.
async function opConcat(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  const list = p.inputs ?? [];
  if (list.length < 2) throw new ToolError("`concat` needs at least two paths in `inputs`.");
  const paths = list.map((f) => requireExisting(cwd, f, "input"));
  const output = prepareOutput(cwd, p.output, "concat");
  const infos = await Promise.all(paths.map((f) => probe(f, signal)));
  for (const [i, info] of infos.entries()) {
    if (!info.hasVideo) throw new ToolError(`${list[i]} has no video stream — use mux_audio for audio.`);
  }

  // Target grid: the explicit size, else the first clip's (which is normally the
  // aspect ratio the whole set was generated at).
  const [w, h] = parseSize(p.size) ?? evenSize(infos[0].width ?? 1280, infos[0].height ?? 720);
  const fps = p.fps && p.fps > 0 ? Math.round(p.fps) : Math.round(infos[0].fps ?? 24);
  const xfade = p.crossfadeSeconds ?? 0;
  if (xfade < 0) throw new ToolError("`crossfadeSeconds` cannot be negative.");
  if (xfade > 0) {
    for (const [i, info] of infos.entries()) {
      if (info.durationSec <= xfade) {
        throw new ToolError(`crossfade of ${xfade}s is longer than clip ${list[i]} (${info.durationSec.toFixed(2)}s).`);
      }
    }
  }

  const args: string[] = [];
  for (const f of paths) args.push("-i", f);

  // A clip with no audio gets a silent track of its own length, so the concat has a
  // uniform stream layout. Mixed audio/no-audio input is the common case the moment a
  // silent image-to-video clip meets one Veo generated a soundtrack for.
  const silenceInputIndex: (number | null)[] = infos.map(() => null);
  let nextIndex = paths.length;
  for (const [i, info] of infos.entries()) {
    if (!info.hasAudio) {
      args.push("-f", "lavfi", "-t", String(Math.max(0.1, info.durationSec)), "-i", "anullsrc=r=48000:cl=stereo");
      silenceInputIndex[i] = nextIndex++;
    }
  }

  const filters: string[] = [];
  for (const [i, info] of infos.entries()) {
    filters.push(normalizeVideo(i, `v${i}`, w, h, fps));
    filters.push(normalizeAudio(info.hasAudio ? i : (silenceInputIndex[i] as number), `a${i}`));
  }

  let vOut: string;
  let aOut: string;
  if (xfade > 0) {
    // xfade takes an absolute offset into the RUNNING timeline, which shortens by one
    // crossfade at every join — hence the running subtraction rather than a plain sum.
    let vPrev = "v0";
    let aPrev = "a0";
    let offset = infos[0].durationSec - xfade;
    for (let i = 1; i < infos.length; i++) {
      const v = `vx${i}`;
      const a = `ax${i}`;
      filters.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${xfade}:offset=${offset.toFixed(3)}[${v}]`);
      filters.push(`[${aPrev}][a${i}]acrossfade=d=${xfade}[${a}]`);
      vPrev = v;
      aPrev = a;
      offset += infos[i].durationSec - xfade;
    }
    vOut = vPrev;
    aOut = aPrev;
  } else {
    const pairs = infos.map((_, i) => `[v${i}][a${i}]`).join("");
    filters.push(`${pairs}concat=n=${infos.length}:v=1:a=1[vcat][acat]`);
    vOut = "vcat";
    aOut = "acat";
  }

  args.push("-filter_complex", filters.join(";"), "-map", `[${vOut}]`, "-map", `[${aOut}]`, ...VIDEO_ENCODE, ...AUDIO_ENCODE, output);
  await ffmpeg(args, signal);

  const result = await probe(output, signal);
  return `Stitched ${paths.length} clips${xfade > 0 ? ` with ${xfade}s crossfades` : ""} → ${output} (${result.durationSec.toFixed(2)}s, ${w}x${h}, ${fps} fps)`;
}

// Still images → a video, each held for a fixed time, optionally cross-dissolving.
async function opSlideshow(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  const list = p.inputs ?? [];
  if (list.length === 0) throw new ToolError("`slideshow` needs image paths in `inputs`.");
  const paths = list.map((f) => requireExisting(cwd, f, "image"));
  const output = prepareOutput(cwd, p.output, "slideshow");
  const hold = p.secondsPerImage && p.secondsPerImage > 0 ? p.secondsPerImage : 3;
  const fps = p.fps && p.fps > 0 ? Math.round(p.fps) : 30;
  const xfade = p.crossfadeSeconds ?? 0;
  if (xfade < 0) throw new ToolError("`crossfadeSeconds` cannot be negative.");
  if (xfade >= hold) throw new ToolError(`\`crossfadeSeconds\` (${xfade}) must be shorter than \`secondsPerImage\` (${hold}).`);

  const infos = await Promise.all(paths.map((f) => probe(f, signal)));
  const [w, h] = parseSize(p.size) ?? evenSize(infos[0].width ?? 1280, infos[0].height ?? 720);

  const args: string[] = [];
  for (const f of paths) args.push("-loop", "1", "-t", String(hold), "-i", f);

  const filters: string[] = [];
  for (let i = 0; i < paths.length; i++) filters.push(normalizeVideo(i, `v${i}`, w, h, fps));

  let vOut = "v0";
  if (paths.length > 1) {
    if (xfade > 0) {
      let prev = "v0";
      let offset = hold - xfade;
      for (let i = 1; i < paths.length; i++) {
        const v = `vx${i}`;
        filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${xfade}:offset=${offset.toFixed(3)}[${v}]`);
        prev = v;
        offset += hold - xfade;
      }
      vOut = prev;
    } else {
      filters.push(`${paths.map((_, i) => `[v${i}]`).join("")}concat=n=${paths.length}:v=1:a=0[vcat]`);
      vOut = "vcat";
    }
  }

  // Silent by design — mux_audio adds narration or a score afterwards. A slideshow
  // with a baked-in empty audio track is harder to score than one with none.
  args.push("-filter_complex", filters.join(";"), "-map", `[${vOut}]`, ...VIDEO_ENCODE, output);
  await ffmpeg(args, signal);
  const result = await probe(output, signal);
  return `Built a ${result.durationSec.toFixed(2)}s slideshow from ${paths.length} image(s) → ${output} (${w}x${h}, ${fps} fps, no audio — add some with mux_audio)`;
}

// Put narration or a score onto a video.
async function opMuxAudio(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`mux_audio` needs `input` (the video).");
  if (!p.audio) throw new ToolError("`mux_audio` needs `audio` (the track to add).");
  const video = requireExisting(cwd, p.input, "video");
  const audio = requireExisting(cwd, p.audio, "audio");
  const output = prepareOutput(cwd, p.output, "mux_audio");
  const [vInfo, aInfo] = await Promise.all([probe(video, signal), probe(audio, signal)]);
  if (!vInfo.hasVideo) throw new ToolError(`${p.input} has no video stream.`);
  if (!aInfo.hasAudio) throw new ToolError(`${p.audio} has no audio stream.`);

  const volume = p.volume != null ? Number(p.volume) : 1;
  if (!Number.isFinite(volume) || volume < 0 || volume > 4) throw new ToolError("`volume` must be between 0 and 4.");

  const args: string[] = ["-i", video];
  // Looping a short score under a long video is the common case; without it the video
  // simply falls silent partway through, which reads as a bug.
  if (p.loopAudio) args.push("-stream_loop", "-1");
  args.push("-i", audio);

  const filters: string[] = [`[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${volume}[anew]`];
  let aOut = "anew";
  if (p.keepOriginalAudio) {
    if (!vInfo.hasAudio) throw new ToolError(`\`keepOriginalAudio\` was set but ${p.input} has no audio to keep.`);
    filters.push("[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aorig]");
    filters.push("[aorig][anew]amix=inputs=2:duration=first:dropout_transition=0,dynaudnorm[amix]");
    aOut = "amix";
  }

  // `-shortest` bounds a looped track to the video. The video stream is copied, so
  // this is fast and lossless whatever the source.
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", `[${aOut}]`,
    "-c:v", "copy", ...AUDIO_ENCODE, "-shortest", output,
  );
  await ffmpeg(args, signal);
  const result = await probe(output, signal);
  return `Muxed ${p.audio} onto ${p.input}${p.loopAudio ? " (looped)" : ""}${p.keepOriginalAudio ? " (mixed with the original audio)" : ""} → ${output} (${result.durationSec.toFixed(2)}s)`;
}

async function opTrim(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`trim` needs `input`.");
  const input = requireExisting(cwd, p.input, "input");
  const output = prepareOutput(cwd, p.output, "trim");
  const start = p.start != null ? Number(p.start) : 0;
  if (!Number.isFinite(start) || start < 0) throw new ToolError("`start` must be a number of seconds >= 0.");
  const info = await probe(input, signal);
  if (info.durationSec && start >= info.durationSec) {
    throw new ToolError(`\`start\` (${start}s) is at or past the end of ${p.input} (${info.durationSec.toFixed(2)}s).`);
  }
  const args = ["-ss", String(start), "-i", input];
  if (p.duration != null) {
    const d = Number(p.duration);
    if (!Number.isFinite(d) || d <= 0) throw new ToolError("`duration` must be a positive number of seconds.");
    args.push("-t", String(d));
  }
  // Re-encoded rather than stream-copied: a copy can only cut on a keyframe, which
  // silently moves the cut by up to a couple of seconds — the opposite of a trim.
  args.push(...VIDEO_ENCODE, ...(info.hasAudio ? AUDIO_ENCODE : ["-an"]), output);
  await ffmpeg(args, signal);
  const result = await probe(output, signal);
  return `Trimmed ${p.input} from ${start}s${p.duration != null ? ` for ${p.duration}s` : " to the end"} → ${output} (${result.durationSec.toFixed(2)}s)`;
}

// Pull a single still out of a video — the move that makes clips continuous: take the
// last frame of clip N and hand it to generate_video as clip N+1's first frame.
async function opExtractFrame(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`extract_frame` needs `input`.");
  const input = requireExisting(cwd, p.input, "input");
  const output = prepareOutput(cwd, p.output, "extract_frame");
  const info = await probe(input, signal);
  if (!info.hasVideo) throw new ToolError(`${p.input} has no video stream.`);

  let at: number;
  if (p.at === "last" || p.at === undefined) {
    // A hair before the end: seeking exactly to the duration lands past the last
    // frame and ffmpeg writes nothing at all.
    at = p.at === undefined ? 0 : Math.max(0, info.durationSec - 0.05);
  } else {
    at = Number(p.at);
    if (!Number.isFinite(at) || at < 0) throw new ToolError('`at` must be a number of seconds, or "last".');
    if (info.durationSec && at > info.durationSec) {
      throw new ToolError(`\`at\` (${at}s) is past the end of ${p.input} (${info.durationSec.toFixed(2)}s).`);
    }
  }

  await ffmpeg(["-ss", String(at), "-i", input, "-frames:v", "1", "-q:v", "2", output], signal);
  if (!existsSync(output)) throw new ToolError(`ffmpeg produced no frame at ${at}s — try a slightly earlier timestamp.`);
  return `Extracted the frame at ${at.toFixed(2)}s of ${p.input} → ${output}`;
}

async function opGif(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`gif` needs `input`.");
  const input = requireExisting(cwd, p.input, "input");
  const output = prepareOutput(cwd, p.output, "gif");
  const fps = p.fps && p.fps > 0 ? Math.round(p.fps) : 12;
  const size = parseSize(p.size);
  const width = size ? size[0] : 640;
  const args = ["-i", input];
  if (p.start != null) args.splice(0, 0, "-ss", String(Number(p.start)));
  if (p.duration != null) args.push("-t", String(Number(p.duration)));
  // Two-pass palette in one graph: a plain gif encode bands badly on generated video.
  args.push(
    "-filter_complex",
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
    "-loop", "0", output,
  );
  await ffmpeg(args, signal);
  return `Made a ${fps} fps GIF from ${p.input} → ${output}`;
}

// ── The tool ─────────────────────────────────────────────────────────────────

export const videoComposeToolDefinition = {
  name: "video_compose",
  label: "Compose Video",
  description:
    "Assemble and edit video and audio files on this machine with ffmpeg. Free, local, and instant — " +
    "no account, no billing. This is the other half of a media workflow: generate_image and " +
    "generate_video produce the raw material, and this turns it into a finished piece.\n" +
    "Operations and the parameters each one uses:\n" +
    "  probe          — input (or inputs): report duration, dimensions, fps and whether there is audio. " +
    "Call this before planning any edit.\n" +
    "  concat         — inputs (2+), output, optional crossfadeSeconds, size, fps: stitch clips end to " +
    "end. Clips of different sizes/frame rates are normalized to the first one (or `size`), and clips " +
    "with no audio get silence so the join doesn't fail.\n" +
    "  slideshow      — inputs (images), output, optional secondsPerImage, crossfadeSeconds, size, fps: " +
    "turn stills into a video. Output is silent; add sound with mux_audio.\n" +
    "  mux_audio      — input (video), audio, output, optional loopAudio, volume, keepOriginalAudio: put " +
    "narration or a score onto a video, trimmed to the video's length.\n" +
    "  trim           — input, output, start, optional duration: cut a section out, frame-accurate.\n" +
    "  extract_frame  — input, output, optional at (seconds, or \"last\"): pull one still. Extract the " +
    "last frame of a clip and pass it to generate_video as `firstFrame` to keep consecutive clips " +
    "visually continuous.\n" +
    "  gif            — input, output, optional start, duration, fps, size: make an animated GIF.\n" +
    "Needs ffmpeg installed; every operation says so plainly if it isn't.",
  parameters: Type.Object({
    operation: Type.String({
      description: 'One of: "probe", "concat", "slideshow", "mux_audio", "trim", "extract_frame", "gif".',
    }),
    inputs: Type.Optional(Type.Array(Type.String(), { description: "Input paths, in order. Used by concat, slideshow, and probe." })),
    input: Type.Optional(Type.String({ description: "A single input path. Used by probe, mux_audio (the video), trim, extract_frame, gif." })),
    audio: Type.Optional(Type.String({ description: "Path to the audio track. mux_audio only." })),
    output: Type.Optional(Type.String({ description: "Where to write the result. Required by everything except probe." })),
    size: Type.Optional(Type.String({ description: 'Target frame size, e.g. "1920x1080". Defaults to the first input\'s size (gif defaults to 640 wide).' })),
    fps: Type.Optional(Type.Number({ description: "Target frame rate. Defaults to the first input's (30 for slideshow, 12 for gif)." })),
    secondsPerImage: Type.Optional(Type.Number({ description: "How long each still is held. slideshow only; defaults to 3." })),
    crossfadeSeconds: Type.Optional(Type.Number({ description: "Cross-dissolve between clips/stills instead of a hard cut. concat and slideshow; defaults to 0 (hard cut)." })),
    start: Type.Optional(Type.Number({ description: "Start offset in seconds. trim and gif." })),
    duration: Type.Optional(Type.Number({ description: "Length in seconds from `start`. trim and gif; omit to run to the end." })),
    at: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: 'Timestamp for extract_frame: seconds, or "last" for the final frame. Defaults to 0.' })),
    volume: Type.Optional(Type.Number({ description: "Volume multiplier for the added track, 0-4. mux_audio only; defaults to 1." })),
    loopAudio: Type.Optional(Type.Boolean({ description: "Repeat a short audio track until the video ends. mux_audio only." })),
    keepOriginalAudio: Type.Optional(Type.Boolean({ description: "Mix under the video's existing audio instead of replacing it. mux_audio only." })),
  }),
  async execute(
    _toolCallId: string,
    params: Params,
    signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const operation = String(params.operation ?? "").trim().toLowerCase() as Operation;
    if (!OPERATIONS.includes(operation)) {
      return text(`Error: unknown operation "${params.operation}". Use one of: ${OPERATIONS.join(", ")}.`);
    }
    try {
      switch (operation) {
        case "probe": return text(await opProbe(cwd, params, signal));
        case "concat": return text(await opConcat(cwd, params, signal));
        case "slideshow": return text(await opSlideshow(cwd, params, signal));
        case "mux_audio": return text(await opMuxAudio(cwd, params, signal));
        case "trim": return text(await opTrim(cwd, params, signal));
        case "extract_frame": return text(await opExtractFrame(cwd, params, signal));
        case "gif": return text(await opGif(cwd, params, signal));
      }
    } catch (e) {
      // ToolError messages are written for the model to act on; anything else is a
      // genuine surprise and is reported as-is rather than dressed up.
      return text(`video_compose ${operation} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/**
 * Extension factory registering the composition tool, for the surfaces that build a
 * session from an explicit `extensionFactories` list. The TUI gets it through
 * `extensions/privateer-media.ts`, passed to Pi as an `-e` argument by the launcher.
 */
export function makeComposeTools() {
  return (pi: { registerTool?: (def: unknown) => void }): void => {
    pi.registerTool?.(videoComposeToolDefinition);
  };
}

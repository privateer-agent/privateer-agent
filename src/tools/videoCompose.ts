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
// FILTERGRAPHS ARE THE SECOND INJECTION SURFACE, and a shell-free spawn does nothing
// about it: `-filter_complex` takes one string that ffmpeg itself parses, where `:`,
// `,`, `;`, `'`, `[` and `\` are all syntax. So no caller-supplied text is ever
// interpolated into a graph raw. Numbers go through `bounded()`, colours through a
// closed pattern, positions through a fixed list of nine names (never an x/y
// expression), paths through `filterPath()`, and prose — a caption — is written to a
// temp file that drawtext READS, so its content is never parsed as a filter at all.
//
// ffmpeg is not a dependency we ship. When it's missing every operation says so once,
// clearly, with the install line for the platform — rather than surfacing ENOENT.

import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Tool names this module registers, for allow-list construction. */
export const COMPOSE_TOOL_NAMES = ["video_compose"] as const;

// A long concat of 1080p clips is genuinely slow; a stuck ffmpeg is not. Bound it.
const FFMPEG_TIMEOUT_MS = Number(process.env.PRIVATEER_FFMPEG_TIMEOUT_MS) || 10 * 60_000;
// Only the tail of stderr is useful (ffmpeg's banner is noise) and the whole thing
// would eat the model's context.
const STDERR_TAIL_CHARS = 1200;

const OPERATIONS = [
  "probe",
  "concat",
  "slideshow",
  "mux_audio",
  "mix_audio",
  "overlay_text",
  "overlay_image",
  "burn_subtitles",
  "trim",
  "extract_frame",
  "gif",
] as const;
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

const AFORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

function normalizeAudio(index: number, label: string): string {
  return `[${index}:a]${AFORMAT},aresample=async=1[${label}]`;
}

// A number from the model, bounded and named. Every numeric parameter that reaches a
// filter string goes through here: it is both the input validation the model gets a
// useful message from, and the guarantee that nothing but a finite number is ever
// interpolated into a filtergraph.
function bounded(v: unknown, label: string, min: number, max: number, dflt: number): number {
  if (v == null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ToolError(`\`${label}\` must be a number between ${min} and ${max} (got ${JSON.stringify(v)}).`);
  }
  return n;
}

// Colours reach ffmpeg as filter option values, so they are matched against a closed
// shape rather than passed through: a name, or #rrggbb(aa). Opacity is a separate
// numeric parameter, which is why `black@0.5` is not accepted here — it would be a
// second, unvalidated way to write a filter option.
const COLOR_RE = /^(?:#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|[a-zA-Z]{3,20})$/;

function colorValue(v: string | undefined, dflt: string, label: string): string {
  const c = String(v ?? dflt).trim();
  if (!COLOR_RE.test(c)) {
    throw new ToolError(`\`${label}\` must be a colour name (e.g. white) or #rrggbb (got ${JSON.stringify(v)}).`);
  }
  return c;
}

// Quote a path for use as a filter OPTION VALUE. Single quotes protect the separators
// the filtergraph parser would otherwise act on, and `\` and `:` are escaped inside them
// so a Windows path (C:\Users\…) survives — verified against ffmpeg 7 with a path
// containing a colon.
function filterPath(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:")}'`;
}

// ── Operations ───────────────────────────────────────────────────────────────

/** One audio track placed on the timeline by `mix_audio`. */
interface MixTrack {
  path: string;
  atSeconds?: number;
  gain?: number;
  loop?: boolean;
  duck?: boolean;
}

/** How type is drawn — shared by an `overlay_text` cue and a whole subtitle file. */
interface TextStyle {
  position?: string;
  fontSize?: number;
  color?: string;
  box?: boolean;
  boxColor?: string;
  boxOpacity?: number;
  marginPx?: number;
}

/** One line of burnt-in type placed by `overlay_text`. */
interface TextCue extends TextStyle {
  text: string;
  fromSeconds?: number;
  toSeconds?: number;
}

/** One still composited onto the picture by `overlay_image`. */
interface ImageLayer {
  path: string;
  fromSeconds?: number;
  toSeconds?: number;
  position?: string;
  widthPercent?: number;
  opacity?: number;
  marginPx?: number;
}

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
  tracks?: (MixTrack | string)[];
  voiceTrack?: number;
  texts?: TextCue[];
  fontFile?: string;
  images?: (ImageLayer | string)[];
  subtitles?: string;
  style?: TextStyle;
  maxCharsPerLine?: number;
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

// Stitch clips back-to-back, optionally with a crossfade between them.
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

// Ducking: press the bed down while the narration is speaking, let it back up between
// lines. A compressor keyed off the voice does this on its own, which is why the level
// isn't a parameter — the alternative is the model authoring a volume envelope per line
// and re-authoring it every time a word changes.
//
// `ratio=12` with a low threshold is a firm duck rather than a gentle one (a marketing
// bed should get out of the way, not merely dip), and `release=350` is long enough that
// the bed doesn't pump between words. attack=15ms keeps the first syllable clear.
const DUCK_FILTER = "sidechaincompress=threshold=0.03:ratio=12:attack=15:release=350:detection=rms";

// Several audio tracks, each placed at a moment and at a level, mixed onto one video.
//
// WHY THIS EXISTS ALONGSIDE mux_audio. mux_audio lays ONE track over the whole video at
// one volume, which is the right tool for "put this narration on" and useless for a cut
// that has narration AND a bed AND effects that land on specific frames. Without
// placement an effect can only start at zero, and without ducking a bed loud enough to
// hear is loud enough to bury the voice — those two gaps are most of the distance
// between "clips with audio" and something that sounds finished.
async function opMixAudio(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`mix_audio` needs `input` (the video the tracks go onto).");
  const raw = p.tracks ?? [];
  if (raw.length === 0) {
    throw new ToolError(
      "`mix_audio` needs at least one entry in `tracks`, each with a `path` (plus optional atSeconds, gain, loop, duck). " +
        "For one track at one level over the whole video, mux_audio is simpler.",
    );
  }
  // A bare string is accepted as a track at 0s and full level: models write
  // `tracks: ["vo.mp3"]` often enough that refusing it teaches nothing.
  const tracks: MixTrack[] = raw.map((t, i) => {
    const track = typeof t === "string" ? { path: t } : ((t ?? {}) as MixTrack);
    if (!track.path) throw new ToolError(`tracks[${i}] has no \`path\`.`);
    return track;
  });

  // Argument validation runs BEFORE anything touches the disk: told that `duck` needs a
  // `voiceTrack`, a model fixes the call; told that a file it hasn't written yet is
  // missing, it goes looking for the wrong problem.
  const voice = p.voiceTrack;
  if (voice != null && (!Number.isInteger(Number(voice)) || Number(voice) < 0 || Number(voice) >= tracks.length)) {
    throw new ToolError(
      `\`voiceTrack\` must be the index of one of the ${tracks.length} track(s) — 0 to ${tracks.length - 1} — got ${JSON.stringify(p.voiceTrack)}.`,
    );
  }
  const ducked = tracks.map((t, i) => (t.duck && i !== voice ? i : -1)).filter((i) => i >= 0);
  if (ducked.length > 0 && voice == null) {
    throw new ToolError(
      "`duck` needs `voiceTrack` set to the index of the track everything else ducks under (normally the narration) — " +
        "there is nothing to duck under otherwise.",
    );
  }

  const video = requireExisting(cwd, p.input, "video");
  const paths = tracks.map((t, i) => requireExisting(cwd, t.path, `tracks[${i}]`));
  const output = prepareOutput(cwd, p.output, "mix_audio");

  const [vInfo, ...tInfos] = await Promise.all([probe(video, signal), ...paths.map((f) => probe(f, signal))]);
  if (!vInfo.hasVideo) throw new ToolError(`${p.input} has no video stream.`);
  for (const [i, info] of tInfos.entries()) {
    if (!info.hasAudio) throw new ToolError(`tracks[${i}] (${tracks[i].path}) has no audio stream.`);
  }

  const args: string[] = ["-i", video];
  for (const [i, t] of tracks.entries()) {
    if (t.loop) {
      if (!(vInfo.durationSec > 0)) {
        throw new ToolError(`\`loop\` needs a video of known length, and ${p.input} reports none.`);
      }
      // Bound the loop AT THE INPUT rather than trusting -shortest to cut an endless
      // stream off inside the graph: amix waits on every input, so an unbounded one
      // makes the encode run until the ffmpeg timeout fires.
      args.push("-stream_loop", "-1", "-t", vInfo.durationSec.toFixed(3));
    }
    args.push("-i", paths[i]);
  }

  const filters: string[] = [];
  const labels: string[] = [];
  if (p.keepOriginalAudio) {
    if (!vInfo.hasAudio) throw new ToolError(`\`keepOriginalAudio\` was set but ${p.input} has no audio to keep.`);
    filters.push(`[0:a]${AFORMAT}[aorig]`);
    labels.push("aorig");
  }

  for (const [i, t] of tracks.entries()) {
    const gain = bounded(t.gain, `tracks[${i}].gain`, 0, 4, 1);
    const at = bounded(t.atSeconds, `tracks[${i}].atSeconds`, 0, 86_400, 0);
    let chain = `[${i + 1}:a]${AFORMAT}`;
    if (gain !== 1) chain += `,volume=${gain}`;
    // adelay is what puts an effect on the frame it belongs to. `all=1` applies the
    // delay to every channel — without it only the first channel moves, which sounds
    // like a broken stereo image rather than a late cue.
    if (at > 0) chain += `,adelay=${Math.round(at * 1000)}:all=1`;
    filters.push(`${chain}[t${i}]`);
  }

  const mixLabel = new Map<number, string>(tracks.map((_, i) => [i, `t${i}`]));
  if (ducked.length > 0) {
    // The voice feeds the mix AND every compressor's sidechain, so it has to be split
    // that many ways: a filter output can only be consumed once.
    filters.push(`[t${voice}]asplit=${ducked.length + 1}[vmix]${ducked.map((_, k) => `[key${k}]`).join("")}`);
    mixLabel.set(voice as number, "vmix");
    ducked.forEach((i, k) => {
      filters.push(`[t${i}][key${k}]${DUCK_FILTER}[d${i}]`);
      mixLabel.set(i, `d${i}`);
    });
  }
  labels.push(...tracks.map((_, i) => mixLabel.get(i) as string));

  // normalize=0 is load-bearing: amix's default divides every input by the number of
  // inputs, so the gains asked for above would silently come out at a third of
  // themselves as soon as a third track joined. The limiter is what keeps the sum from
  // clipping instead.
  if (labels.length > 1) {
    filters.push(
      `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[amixed]`,
    );
  } else {
    filters.push(`[${labels[0]}]anull[amixed]`);
  }
  filters.push("[amixed]alimiter=limit=0.95[aout]");

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]",
    // The picture is untouched, so it is copied: a mix must never be a reason to
    // re-encode video and lose a generation of quality.
    "-c:v", "copy", ...AUDIO_ENCODE, "-shortest", output,
  );
  await ffmpeg(args, signal);

  const result = await probe(output, signal);
  const placed = tracks
    .map((t, i) => {
      const bits: string[] = [t.path];
      if (t.atSeconds) bits.push(`at ${Number(t.atSeconds)}s`);
      if (t.gain != null && Number(t.gain) !== 1) bits.push(`gain ${Number(t.gain)}`);
      if (t.loop) bits.push("looped");
      if (i === voice) bits.push("voice");
      else if (ducked.includes(i)) bits.push("ducked under the voice");
      return `  ${bits.join(", ")}`;
    })
    .join("\n");
  return (
    `Mixed ${tracks.length} track(s) onto ${p.input}` +
    `${p.keepOriginalAudio ? " over its own audio" : ""} → ${output} (${result.durationSec.toFixed(2)}s)\n${placed}`
  );
}

// Burn type into the picture: a caption, a lower third, an end card.
//
// The text is written to a TEMPORARY FILE and read back by drawtext's `textfile=`
// rather than interpolated into the filtergraph as `text=`. That is not tidiness: a
// caption is model- or user-supplied prose, and `:`, `,`, `'`, `%`, `[` and `\` all mean
// something to the filter parser. Escaping them correctly through two levels of quoting
// is exactly the kind of thing that works until someone writes a price or a ratio in a
// caption, at which point the graph either fails or silently means something else.
// `expansion=none` closes the other half of the same hole — drawtext would otherwise
// evaluate `%{...}` sequences inside the text.
async function opOverlayText(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`overlay_text` needs `input` (the video to draw on).");
  const cues = p.texts ?? [];
  if (cues.length === 0) {
    throw new ToolError(
      "`overlay_text` needs at least one entry in `texts`, each with `text` (plus optional fromSeconds, toSeconds, " +
        "position, fontSize, color, box).",
    );
  }
  const input = requireExisting(cwd, p.input, "video");
  const output = prepareOutput(cwd, p.output, "overlay_text");
  const info = await probe(input, signal);
  if (!info.hasVideo) throw new ToolError(`${p.input} has no video stream.`);

  const font = resolveFont(cwd, p.fontFile);
  const tmp = mkdtempSync(join(tmpdir(), "pv-drawtext-"));
  try {
    const drawtexts = cues.map((cue, i) =>
      buildDrawtext({ cue: cue ?? ({} as TextCue), index: i, label: `texts[${i}]`, font, info, tmp }),
    );
    await drawOnVideo(input, output, drawtexts, info, signal);
    const result = await probe(output, signal);
    return `Burned ${cues.length} text overlay(s) into ${p.input} → ${output} (${result.durationSec.toFixed(2)}s, ${result.width}x${result.height})`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// One `drawtext` filter for one cue. Shared by overlay_text and burn_subtitles so a
// caption and a subtitle are styled, bounded and (above all) ESCAPED by the same code:
// the second copy of this is the one that would forget `expansion=none`.
function buildDrawtext(args: {
  cue: TextCue;
  index: number;
  label: string;
  font: string;
  info: MediaInfo;
  tmp: string;
  defaults?: { position?: string; box?: boolean };
}): string {
  const { cue, index, label, font, info, tmp } = args;
  const body = String(cue.text ?? "");
  if (!body.trim()) throw new ToolError(`${label} has no \`text\`.`);
  // Default type size scales with the frame: a 48px caption is right on 1080p and
  // unreadable on a 4K master, and the model has no reliable idea which it holds.
  const height = info.height ?? 1080;
  const fontSize = Math.round(bounded(cue.fontSize, `${label}.fontSize`, 8, 400, Math.max(16, Math.round(height / 20))));
  const margin = Math.round(bounded(cue.marginPx, `${label}.marginPx`, 0, 2000, Math.round(fontSize * 0.8)));
  const { x, y } = positionExpr(cue.position ?? args.defaults?.position ?? "bottom", margin, label);
  const opts = [
    `fontfile=${filterPath(font)}`,
    `textfile=${filterPath(writeCueFile(tmp, index, body))}`,
    "expansion=none",
    `fontsize=${fontSize}`,
    `fontcolor=${colorValue(cue.color, "white", `${label}.color`)}`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (cue.box ?? args.defaults?.box) {
    const opacity = bounded(cue.boxOpacity, `${label}.boxOpacity`, 0, 1, 0.5);
    opts.push("box=1", `boxcolor=${colorValue(cue.boxColor, "black", `${label}.boxColor`)}@${opacity}`, `boxborderw=${Math.round(fontSize / 3)}`);
  } else {
    // No box means the type has to hold against whatever is behind it, and generated
    // footage is rarely obligingly dark. A border is cheaper than a box and reads
    // as design rather than as a subtitle.
    opts.push(`borderw=${Math.max(1, Math.round(fontSize / 16))}`, "bordercolor=black@0.85");
  }
  const from = cue.fromSeconds == null ? null : bounded(cue.fromSeconds, `${label}.fromSeconds`, 0, 86_400, 0);
  const to = cue.toSeconds == null ? null : bounded(cue.toSeconds, `${label}.toSeconds`, 0, 86_400, 0);
  if (from != null && to != null && to <= from) {
    throw new ToolError(`${label}: toSeconds (${to}) must be after fromSeconds (${from}).`);
  }
  // Absent bounds mean "for the whole video", which is what omitting `enable` does.
  if (from != null || to != null) {
    opts.push(`enable='between(t,${from ?? 0},${to ?? Math.max(from ?? 0, info.durationSec || 86_400)})'`);
  }
  return `drawtext=${opts.join(":")}`;
}

// Run a chain of video filters over the picture and leave the sound alone. The picture is
// re-encoded (it has to be — we are drawing on it) and the audio is copied through
// untouched, so adding a caption never costs a generation of sound.
async function drawOnVideo(
  input: string,
  output: string,
  filters: string[],
  info: MediaInfo,
  signal?: AbortSignal,
): Promise<void> {
  await ffmpeg(
    [
      "-i", input,
      "-filter_complex", `[0:v]${filters.join(",")}[vout]`,
      "-map", "[vout]",
      ...(info.hasAudio ? ["-map", "0:a", "-c:a", "copy"] : []),
      ...VIDEO_ENCODE,
      output,
    ],
    signal,
  );
}

function writeCueFile(dir: string, index: number, body: string): string {
  const file = join(dir, `cue-${index}.txt`);
  writeFileSync(file, body, "utf8");
  return file;
}

const POSITIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;

// The frame/element variable names a filter exposes for placement. drawtext measures the
// frame as w/h and the drawn text as text_w/text_h; overlay measures the MAIN input as
// W/H and the overlaid one as w/h. Same nine positions, two vocabularies.
const DRAWTEXT_VARS = { frameW: "w", frameH: "h", itemW: "text_w", itemH: "text_h" };
const OVERLAY_VARS = { frameW: "W", frameH: "H", itemW: "w", itemH: "h" };

// Named positions only — never a caller-supplied x/y expression. Both filters evaluate x
// and y as arithmetic over frame variables, so accepting one would hand the model (or
// anything that reached it) an expression evaluator inside the filtergraph. The nine names
// below cover every placement a title, caption or logo actually wants.
function positionExpr(
  position: string,
  margin: number,
  label: string,
  vars: typeof DRAWTEXT_VARS = DRAWTEXT_VARS,
): { x: string; y: string } {
  const name = String(position).trim().toLowerCase();
  if (!(POSITIONS as readonly string[]).includes(name)) {
    throw new ToolError(`${label}.position must be one of: ${POSITIONS.join(", ")} (got ${JSON.stringify(position)}).`);
  }
  const y = name.startsWith("top")
    ? String(margin)
    : name.startsWith("bottom")
      ? `${vars.frameH}-${vars.itemH}-${margin}`
      : `(${vars.frameH}-${vars.itemH})/2`;
  const x = name.endsWith("left")
    ? String(margin)
    : name.endsWith("right")
      ? `${vars.frameW}-${vars.itemW}-${margin}`
      : `(${vars.frameW}-${vars.itemW})/2`;
  return { x, y };
}

// Where to find a font, in order: the one the caller named, then the platform's usual
// suspects. drawtext with neither `fontfile` nor `font` only works on a build with
// fontconfig, and the failure ("Cannot find a valid font...") arrives after the encode
// starts — so a path is resolved here, up front, where the message can name the fix.
const FONT_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
  ],
  linux: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
  ],
  win32: ["C:\\Windows\\Fonts\\arialbd.ttf", "C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\segoeui.ttf"],
};

function resolveFont(cwd: string, fontFile?: string): string {
  if (fontFile) return requireExisting(cwd, fontFile, "fontFile");
  for (const candidate of FONT_CANDIDATES[process.platform] ?? FONT_CANDIDATES.linux) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ToolError(
    "no system font found to draw with — pass `fontFile` with the path to a .ttf/.otf " +
      `(looked for ${(FONT_CANDIDATES[process.platform] ?? FONT_CANDIDATES.linux).join(", ")}).`,
  );
}

// Composite stills onto the picture: the logo bug in the corner, an end card, a lower-third
// plate a caption then sits on. The move overlay_text can't make — type is not artwork, and
// a brand mark drawn as text is a brand mark drawn wrong.
async function opOverlayImage(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`overlay_image` needs `input` (the video to draw on).");
  const raw = p.images ?? [];
  if (raw.length === 0) {
    throw new ToolError(
      "`overlay_image` needs at least one entry in `images`, each with a `path` (plus optional fromSeconds, " +
        "toSeconds, position, widthPercent, opacity, marginPx).",
    );
  }
  // A bare string is a full-strength overlay at the default position, for the same reason
  // mix_audio accepts one: `images: ["logo.png"]` is what a model writes first.
  const layers: ImageLayer[] = raw.map((entry, i) => {
    const layer = typeof entry === "string" ? { path: entry } : ((entry ?? {}) as ImageLayer);
    if (!layer.path) throw new ToolError(`images[${i}] has no \`path\`.`);
    return layer;
  });

  // Everything checkable without the disk is checked first, as in mix_audio: told that
  // `position` isn't one of the nine, a model fixes the call; told that a file it is about
  // to write doesn't exist yet, it goes looking for the wrong problem. (The numeric bounds
  // below are re-applied where they are used — a second call to `bounded` with the same
  // value is free, and one shared place to validate would need the probe results.)
  layers.forEach((layer, i) => {
    const label = `images[${i}]`;
    positionExpr(layer.position ?? "top-right", 0, label, OVERLAY_VARS);
    bounded(layer.opacity, `${label}.opacity`, 0, 1, 1);
    bounded(layer.widthPercent, `${label}.widthPercent`, 1, 100, 100);
    const from = bounded(layer.fromSeconds, `${label}.fromSeconds`, 0, 86_400, 0);
    const to = layer.toSeconds == null ? null : bounded(layer.toSeconds, `${label}.toSeconds`, 0, 86_400, 0);
    if (layer.fromSeconds != null && to != null && to <= from) {
      throw new ToolError(`${label}: toSeconds (${to}) must be after fromSeconds (${from}).`);
    }
  });

  const input = requireExisting(cwd, p.input, "video");
  const paths = layers.map((l, i) => requireExisting(cwd, l.path, `images[${i}]`));
  const output = prepareOutput(cwd, p.output, "overlay_image");
  const [info, ...layerInfos] = await Promise.all([probe(input, signal), ...paths.map((f) => probe(f, signal))]);
  if (!info.hasVideo) throw new ToolError(`${p.input} has no video stream.`);
  for (const [i, li] of layerInfos.entries()) {
    if (!li.hasVideo) throw new ToolError(`images[${i}] (${layers[i].path}) is not an image or video ffmpeg can read.`);
  }

  const frameW = info.width ?? 1280;
  const args: string[] = ["-i", input];
  for (const [i, li] of layerInfos.entries()) {
    // A still decodes to ONE frame, which composited over a 30s video appears on frame 1
    // and is gone — so a still is looped for the video's length, while an animated overlay
    // (a GIF, a video sting) plays at its own pace and `eof_action=pass` below lets the
    // film carry on after it ends.
    //
    // DURATION is what distinguishes them, not frame rate: the image demuxer fabricates
    // `avg_frame_rate=25/1` for a PNG, so keying off fps silently skipped the loop and
    // produced a video whose logo flashed on the first frame only.
    if (li.durationSec === 0 && info.durationSec > 0) args.push("-loop", "1", "-t", info.durationSec.toFixed(3));
    args.push("-i", paths[i]);
  }

  const filters: string[] = [];
  const scaledTo: (number | null)[] = [];
  for (const [i, layer] of layers.entries()) {
    const label = `images[${i}]`;
    const pct = layer.widthPercent == null ? null : bounded(layer.widthPercent, `${label}.widthPercent`, 1, 100, 100);
    const nativeW = layerInfos[i].width ?? frameW;
    // No widthPercent means "as authored" — EXCEPT when the art is wider than the frame,
    // where leaving it alone silently crops the overlay off the right-hand side and reads
    // as a broken render rather than as a choice.
    const targetW = pct != null ? Math.round((frameW * pct) / 100) : nativeW > frameW ? frameW : null;
    scaledTo.push(targetW);
    const chain: string[] = [];
    if (targetW != null) chain.push(`scale=${Math.max(2, targetW - (targetW % 2))}:-1`);
    const opacity = bounded(layer.opacity, `${label}.opacity`, 0, 1, 1);
    // A watermark has to let the picture through. colorchannelmixer SCALES the alpha
    // channel, so `format=rgba` first: art saved without transparency has no alpha to
    // scale, and the layer would come out fully opaque with no error.
    if (opacity < 1) chain.push("format=rgba", `colorchannelmixer=aa=${opacity}`);
    filters.push(`[${i + 1}:v]${chain.length > 0 ? chain.join(",") : "null"}[img${i}]`);
  }

  let vPrev = "0:v";
  layers.forEach((layer, i) => {
    const label = `images[${i}]`;
    const margin = Math.round(bounded(layer.marginPx, `${label}.marginPx`, 0, 2000, Math.round(frameW * 0.03)));
    const { x, y } = positionExpr(layer.position ?? "top-right", margin, label, OVERLAY_VARS);
    const from = layer.fromSeconds == null ? null : bounded(layer.fromSeconds, `${label}.fromSeconds`, 0, 86_400, 0);
    const to = layer.toSeconds == null ? null : bounded(layer.toSeconds, `${label}.toSeconds`, 0, 86_400, 0);
    if (from != null && to != null && to <= from) {
      throw new ToolError(`${label}: toSeconds (${to}) must be after fromSeconds (${from}).`);
    }
    const opts = [`x=${x}`, `y=${y}`];
    if (from != null || to != null) {
      opts.push(`enable='between(t,${from ?? 0},${to ?? Math.max(from ?? 0, info.durationSec || 86_400)})'`);
    }
    // `eof_action=pass` keeps the MAIN video running once a layer's own frames end (a
    // windowed overlay, or art shorter than the video): the default would end the output
    // there, truncating the film to the length of its logo.
    opts.push("eof_action=pass");
    const next = i === layers.length - 1 ? "vout" : `vo${i}`;
    filters.push(`[${vPrev}][img${i}]overlay=${opts.join(":")}[${next}]`);
    vPrev = next;
  });

  await ffmpeg(
    [
      ...args,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      ...(info.hasAudio ? ["-map", "0:a", "-c:a", "copy"] : []),
      ...VIDEO_ENCODE,
      output,
    ],
    signal,
  );
  const result = await probe(output, signal);
  const placed = layers
    .map((l, i) => {
      const bits = [l.path, l.position ?? "top-right"];
      if (scaledTo[i] != null) bits.push(`${scaledTo[i]}px wide`);
      if (l.opacity != null && Number(l.opacity) < 1) bits.push(`opacity ${Number(l.opacity)}`);
      if (l.fromSeconds != null || l.toSeconds != null) bits.push(`${l.fromSeconds ?? 0}s-${l.toSeconds ?? "end"}`);
      return `  ${bits.join(", ")}`;
    })
    .join("\n");
  return `Composited ${layers.length} image(s) onto ${p.input} → ${output} (${result.durationSec.toFixed(2)}s, ${result.width}x${result.height})\n${placed}`;
}

// A graph with a drawtext per cue is the cost of this approach; bound it rather than
// building a filter string megabytes long and letting ffmpeg fail on argv length.
const MAX_SUBTITLE_CUES = 500;
// The broadcast convention, and about what fits at frame-height/20 on a 16:9 master.
const DEFAULT_SUBTITLE_CHARS = 42;

// Burn a subtitle file into the picture.
//
// WHY WE PARSE IT OURSELVES rather than handing ffmpeg's `subtitles=` filter the file.
// That filter needs libass, which is a build option and not present in every ffmpeg a user
// has installed — and its styling goes through `force_style`, a comma-separated string
// inside a filter option value, which is a second quoting layer to get wrong on exactly the
// kind of caller-supplied text this file is careful about everywhere else. Parsing SRT/VTT
// here and emitting the same drawtext cues overlay_text uses means one text path, already
// escaped (textfile= + expansion=none), and no dependency beyond drawtext itself.
//
// What that costs, stated plainly: no italics, no per-cue positioning overrides, no
// karaoke timing. Styling is uniform across the file, which is what burnt-in captions on a
// marketing cut want anyway.
async function opBurnSubtitles(cwd: string, p: Params, signal?: AbortSignal): Promise<string> {
  if (!p.input) throw new ToolError("`burn_subtitles` needs `input` (the video to draw on).");
  if (!p.subtitles) throw new ToolError("`burn_subtitles` needs `subtitles` (the path to an .srt or .vtt file).");
  const wrapAt = Math.round(bounded(p.maxCharsPerLine, "maxCharsPerLine", 10, 200, DEFAULT_SUBTITLE_CHARS));
  const input = requireExisting(cwd, p.input, "video");
  const subs = requireExisting(cwd, p.subtitles, "subtitles");
  const output = prepareOutput(cwd, p.output, "burn_subtitles");
  const info = await probe(input, signal);
  if (!info.hasVideo) throw new ToolError(`${p.input} has no video stream.`);

  const parsed = parseSubtitleCues(readFileSync(subs, "utf8"));
  if (parsed.length === 0) {
    throw new ToolError(
      `no cues found in ${p.subtitles} — expected SubRip (.srt) or WebVTT (.vtt), where each cue is a ` +
        "`00:00:01,000 --> 00:00:04,000` line followed by its text.",
    );
  }
  if (parsed.length > MAX_SUBTITLE_CUES) {
    throw new ToolError(
      `${p.subtitles} has ${parsed.length} cues, over the ${MAX_SUBTITLE_CUES} this can burn in one pass. ` +
        "Trim the video and its subtitles into sections and burn each, or use fewer, longer cues.",
    );
  }

  const style = (p.style ?? {}) as TextStyle;
  const font = resolveFont(cwd, p.fontFile);
  const tmp = mkdtempSync(join(tmpdir(), "pv-subtitles-"));
  try {
    const drawtexts = parsed.map((cue, i) =>
      buildDrawtext({
        cue: { ...style, text: wrapLines(cue.text, wrapAt), fromSeconds: cue.from, toSeconds: cue.to },
        index: i,
        label: "style",
        font,
        info,
        tmp,
        // Captions live at the bottom, and against generated footage they need a plate
        // more often than a title does — so a box is the default here where overlay_text
        // defaults to an outline. `style.box: false` turns it back off.
        defaults: { position: "bottom", box: true },
      }),
    );
    await drawOnVideo(input, output, drawtexts, info, signal);
    const result = await probe(output, signal);
    const last = parsed[parsed.length - 1];
    return (
      `Burned ${parsed.length} subtitle cue(s) from ${p.subtitles} into ${p.input} → ${output} ` +
      `(${result.durationSec.toFixed(2)}s, wrapped at ${wrapAt} characters, last cue ends at ${last.to.toFixed(2)}s)` +
      (last.to > info.durationSec + 0.5
        ? `\nNote: the subtitles run ${(last.to - info.durationSec).toFixed(2)}s past the end of the video — ` +
          "those cues will never be seen."
        : "")
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface ParsedCue {
  from: number;
  to: number;
  text: string;
}

// "00:00:01,000", "00:00:01.000", "01:02.500" (VTT drops the hour) → seconds.
function parseTimecode(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

// Inline markup we cannot render and must not print: SRT/VTT tags (<i>, <c.yellow>) and
// ASS override blocks ({\an8}). Dropped rather than escaped — a caption reading "<i>" is
// worse than one that lost its italics.
function stripMarkup(s: string): string {
  return s.replace(/<[^>\n]*>/g, "").replace(/\{\\[^}\n]*\}/g, "");
}

// Cue-block parser covering both formats, because they differ only in the separator inside
// the timestamp and in a header/settings line we can ignore. Anything that isn't a cue —
// SubRip's sequence numbers, `WEBVTT`, `NOTE` blocks, styling blocks — is skipped by
// keying off the `-->` line rather than by counting lines, which is what makes a
// hand-edited file with an extra blank line parse rather than derail.
export function parseSubtitleCues(body: string): ParsedCue[] {
  const lines = body.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: ParsedCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow === -1) continue;
    const from = parseTimecode(lines[i].slice(0, arrow));
    // WebVTT cue settings ("align:start line:90%") follow the end time on the same line.
    const to = parseTimecode(lines[i].slice(arrow + 3).trim().split(/\s+/)[0] ?? "");
    if (from == null || to == null || to <= from) continue;
    const text: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== ""; j++) text.push(lines[j]);
    i = j;
    const clean = stripMarkup(text.join("\n"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (clean) cues.push({ from, to, text: clean });
  }
  return cues;
}

// Wrap to a character count, per authored line. drawtext does not wrap, so a cue written as
// one long line would run off both edges of the frame. Existing line breaks are kept — a
// subtitler who split a line meant it — and only over-long lines are broken further.
export function wrapLines(text: string, max: number): string {
  return text
    .split("\n")
    .map((line) => {
      const out: string[] = [];
      let current = "";
      for (const word of line.split(/\s+/).filter(Boolean)) {
        if (current === "") current = word;
        else if (current.length + 1 + word.length <= max) current += ` ${word}`;
        else {
          out.push(current);
          current = word;
        }
      }
      if (current) out.push(current);
      return out.join("\n");
    })
    .join("\n");
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
    "ONE track onto a video at one level, trimmed to the video's length.\n" +
    "  mix_audio      — input (video), tracks, output, optional voiceTrack, keepOriginalAudio: put SEVERAL " +
    "tracks on at once, each placed and levelled. Every track takes `path` plus optional `atSeconds` (when " +
    "it starts — this is how a sound effect lands on the frame it belongs to), `gain` (0-4), `loop` (repeat " +
    "a short bed to the end) and `duck` (press this track down while the narration speaks). Set " +
    "`voiceTrack` to the index of the narration for `duck` to key off. Use this rather than several " +
    "mux_audio passes: each pass re-encodes the sound and mixes blind to what comes next.\n" +
    "  overlay_text   — input (video), texts, output, optional fontFile: burn type into the picture. Each " +
    "entry takes `text` plus optional `fromSeconds`/`toSeconds` (when it shows), `position` (one of " +
    "top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right), `fontSize` " +
    "(defaults to the frame height / 20), `color`, `box`, `boxColor`, `boxOpacity`, `marginPx`. Audio is " +
    "copied through untouched.\n" +
    "  overlay_image  — input (video), images, output: composite stills onto the picture — a logo bug, an " +
    "end card, a lower-third plate. Each entry takes `path` plus optional `fromSeconds`/`toSeconds`, " +
    "`position` (same nine names, defaults to top-right), `widthPercent` (of the frame width — the way to " +
    "size a logo, since the art's own pixel size means nothing), `opacity` (0-1, for a watermark) and " +
    "`marginPx`. Audio is copied through untouched.\n" +
    "  burn_subtitles — input (video), subtitles (.srt or .vtt), output, optional style, maxCharsPerLine, " +
    "fontFile: burn a whole subtitle file in, timed from the file itself. Lines are wrapped to fit (42 " +
    "characters by default) and drawn at the bottom on a plate; `style` takes the same fields as an " +
    "overlay_text entry and applies to every cue. Needs no libass — italics and per-cue positioning in the " +
    "file are dropped, everything else is honoured.\n" +
    "  trim           — input, output, start, optional duration: cut a section out, frame-accurate.\n" +
    "  extract_frame  — input, output, optional at (seconds, or \"last\"): pull one still. Extract the " +
    "last frame of a clip and pass it to generate_video as `firstFrame` to keep consecutive clips " +
    "visually continuous.\n" +
    "  gif            — input, output, optional start, duration, fps, size: make an animated GIF.\n" +
    "Needs ffmpeg installed; every operation says so plainly if it isn't.",
  parameters: Type.Object({
    operation: Type.String({
      description:
        'One of: "probe", "concat", "slideshow", "mux_audio", "mix_audio", "overlay_text", "overlay_image", "burn_subtitles", "trim", "extract_frame", "gif".',
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
    keepOriginalAudio: Type.Optional(Type.Boolean({ description: "Mix under the video's existing audio instead of replacing it. mux_audio and mix_audio." })),
    tracks: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String({ description: "The audio file." }),
          atSeconds: Type.Optional(Type.Number({ description: "When it starts, in seconds from the beginning of the video. Defaults to 0." })),
          gain: Type.Optional(Type.Number({ description: "Volume multiplier, 0-4. Defaults to 1. A bed under narration usually wants 0.2-0.4." })),
          loop: Type.Optional(Type.Boolean({ description: "Repeat this track until the video ends — for a short music bed." })),
          duck: Type.Optional(Type.Boolean({ description: "Press this track down whenever the `voiceTrack` is speaking, and let it back up between lines." })),
        }),
        { description: "The tracks to place, in any order. mix_audio only." },
      ),
    ),
    voiceTrack: Type.Optional(
      Type.Number({
        description:
          "Index into `tracks` of the narration everything else ducks under (0 = the first track). " +
          "Required if any track sets `duck`. mix_audio only.",
      }),
    ),
    texts: Type.Optional(
      Type.Array(
        Type.Object({
          text: Type.String({ description: "The words to draw. Punctuation, colons and percent signs are all safe — the text never reaches the filter as syntax." }),
          fromSeconds: Type.Optional(Type.Number({ description: "When it appears. Omit for the whole video." })),
          toSeconds: Type.Optional(Type.Number({ description: "When it disappears. Omit to hold to the end." })),
          position: Type.Optional(Type.String({ description: "top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right. Defaults to bottom." })),
          fontSize: Type.Optional(Type.Number({ description: "In pixels, 8-400. Defaults to the frame height / 20." })),
          color: Type.Optional(Type.String({ description: "A colour name or #rrggbb. Defaults to white." })),
          box: Type.Optional(Type.Boolean({ description: "Draw a filled box behind the type. Without it the type gets a dark outline instead." })),
          boxColor: Type.Optional(Type.String({ description: "Box colour name or #rrggbb. Defaults to black." })),
          boxOpacity: Type.Optional(Type.Number({ description: "Box opacity, 0-1. Defaults to 0.5." })),
          marginPx: Type.Optional(Type.Number({ description: "Distance from the frame edge. Defaults to about 0.8 of the font size." })),
        }),
        { description: "The text to burn in. overlay_text only." },
      ),
    ),
    fontFile: Type.Optional(
      Type.String({
        description:
          "Path to a .ttf/.otf to draw with. Omit to use a system font — pass one if the video needs the brand's typeface. overlay_text and burn_subtitles.",
      }),
    ),
    images: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String({ description: "The image (or short video) to composite. PNG transparency is preserved." }),
          fromSeconds: Type.Optional(Type.Number({ description: "When it appears. Omit for the whole video." })),
          toSeconds: Type.Optional(Type.Number({ description: "When it disappears. Omit to hold to the end." })),
          position: Type.Optional(Type.String({ description: "top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right. Defaults to top-right." })),
          widthPercent: Type.Optional(Type.Number({ description: "Width as a percentage of the video's width, 1-100. The right way to size a logo. Omit to use the art at its own size (shrunk to fit if it is wider than the frame)." })),
          opacity: Type.Optional(Type.Number({ description: "0-1. Defaults to 1 (opaque); 0.3-0.6 is the range a watermark wants." })),
          marginPx: Type.Optional(Type.Number({ description: "Distance from the frame edge. Defaults to about 3% of the frame width." })),
        }),
        { description: "The images to composite, drawn in order (later entries sit on top). overlay_image only." },
      ),
    ),
    subtitles: Type.Optional(
      Type.String({ description: "Path to a SubRip (.srt) or WebVTT (.vtt) file. Its own timings drive the cues. burn_subtitles only." }),
    ),
    style: Type.Optional(
      Type.Object({
        position: Type.Optional(Type.String({ description: "Where every cue sits. Defaults to bottom." })),
        fontSize: Type.Optional(Type.Number({ description: "In pixels, 8-400. Defaults to the frame height / 20." })),
        color: Type.Optional(Type.String({ description: "A colour name or #rrggbb. Defaults to white." })),
        box: Type.Optional(Type.Boolean({ description: "Draw a plate behind the type. Defaults to TRUE for subtitles; set false for an outline instead." })),
        boxColor: Type.Optional(Type.String({ description: "Plate colour name or #rrggbb. Defaults to black." })),
        boxOpacity: Type.Optional(Type.Number({ description: "Plate opacity, 0-1. Defaults to 0.5." })),
        marginPx: Type.Optional(Type.Number({ description: "Distance from the frame edge. Defaults to about 0.8 of the font size." })),
      }, { description: "How every subtitle cue is drawn. burn_subtitles only." }),
    ),
    maxCharsPerLine: Type.Optional(
      Type.Number({
        description:
          "Wrap subtitle lines longer than this, 10-200. Defaults to 42 (the broadcast convention). burn_subtitles only.",
      }),
    ),
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
        case "mix_audio": return text(await opMixAudio(cwd, params, signal));
        case "overlay_text": return text(await opOverlayText(cwd, params, signal));
        case "overlay_image": return text(await opOverlayImage(cwd, params, signal));
        case "burn_subtitles": return text(await opBurnSubtitles(cwd, params, signal));
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

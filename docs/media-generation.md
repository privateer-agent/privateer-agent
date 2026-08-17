# Media generation — images, video, 3D, speech, music, sound effects

The agent can create media through the signed-in Privateer account and assemble it
locally with ffmpeg. Eight tools, two server routes, and a switch.

Nothing here is BYO-key: every generation call is billed to the user's Privateer
subscription over the session token the terminal already holds, so no provider key ever
sits in the environment for a prompt-injected run to read out.

---

## The tools

| Tool | What it does | Costs |
|---|---|---|
| `generate_image` | Text → image, or edit/compose from images already on disk | cents per image |
| `generate_video` | Text → video clip; optional first/last frame stills | ~$0.10–$1 per clip |
| `generate_model` | Reference image(s) → 3D mesh | $0.14–$2.41 per mesh |
| `generate_speech` | Text → spoken audio (narration) | fractions of a cent |
| `generate_music` | Text → instrumental audio (a score) | ~$0.04–$0.08 per call |
| `generate_sfx` | Text → one sound effect, 1–30s | ~$0.01–$0.02 per call |
| `media_capabilities` | What this account can do right now | free |
| `video_compose` | Local ffmpeg: probe, concat, slideshow, mux_audio, mix_audio, overlay_text, **overlay_image**, **burn_subtitles**, trim, extract_frame, gif | free |

Every tool takes an explicit output `path` and returns it. That is what makes a
*workflow* possible rather than a one-shot: the file each step writes is the file the
next step reads.

### The three audio tools are not interchangeable

They differ in what they are *for* and — the part that is easy to get backwards — in
their privacy posture, which runs the opposite way to the intuition:

| | For | ZDR gate |
|---|---|---|
| `generate_speech` | narration | runs **confidentially** (the account's default TTS model is a confidential-compute one) |
| `generate_sfx` | one sound: an impact, a whoosh, a room | **gated like image/video** — fal is non-ZDR, so a Require-ZDR account is refused |
| `generate_music` | a bed, a score | **no gate at all** — no music model anywhere has a ZDR endpoint, so gating it would empty the picker |

So `generate_music` is the *loosest* of the three, not the safest. Never offer it as the
privacy-friendly substitute for a blocked sound effect.

### Where they live

- `src/tools/media.ts` — the seven account-backed tools (`MEDIA_TOOL_NAMES`)
- `src/tools/videoCompose.ts` — the local ffmpeg tool (`COMPOSE_TOOL_NAMES`)
- `extensions/privateer-media.ts` — the TUI shim (installed by `bin/privateer-launch.mjs`)
- registered directly in `harbor/index.ts`, `channels/run.ts`, `acp/run.ts`,
  `cli/chat.ts`, `remote/liveTaskSession.ts` — the surfaces that build their session
  from an explicit factory list instead of the shim directory

---

## Worked example: a scored, narrated 20-second video

This is the shape the tools are designed around, and the one to reach for when a user
asks for "a short video about X".

```
media_capabilities                                    → veo-3.1-lite, clips of 4/6/8s, 16:9

generate_image  prompt="…establishing shot…"          → frames/01.png
generate_video  prompt="…slow push in…"
                firstFrame=frames/01.png  seconds=8   → clips/01.mp4

video_compose   extract_frame  input=clips/01.mp4
                at="last"                             → frames/02.png     ← the continuity trick
generate_video  prompt="…continues, camera pans…"
                firstFrame=frames/02.png  seconds=8   → clips/02.mp4

video_compose   concat  inputs=[clips/01.mp4, clips/02.mp4]
                crossfadeSeconds=0.5                  → cut.mp4

generate_speech text="…narration…"                    → audio/vo.mp3
generate_music  prompt="warm ambient pad, 70bpm"      → audio/score.mp3
generate_sfx    prompt="deep whoosh, fast riser"  seconds=2 → audio/sfx/whoosh.mp3

video_compose   mix_audio  input=cut.mp4               ← ONE pass, not three
                voiceTrack=0
                tracks=[ {path: audio/vo.mp3},
                         {path: audio/score.mp3, gain: 0.3, loop: true, duck: true},
                         {path: audio/sfx/whoosh.mp3, atSeconds: 7.6} ] → scored.mp4

video_compose   overlay_text  input=scored.mp4
                texts=[ {text: "Your keys. Your model.", position: "bottom",
                         fromSeconds: 1, toSeconds: 4},
                        {text: "privateer.pro", position: "center",
                         fromSeconds: 14} ]           → titled.mp4

video_compose   overlay_image  input=titled.mp4       ← the brand mark, as artwork
                images=[ {path: brand/logo.png, position: "top-right",
                          widthPercent: 12, opacity: 0.85} ] → final.mp4
```

Three steps are load-bearing:

- **`extract_frame at="last"` → `generate_video firstFrame=…`.** Video models have no
  memory between calls, so without it consecutive clips look like unrelated shots. With
  it they read as one continuous take.
- **`mix_audio` in one pass, with `atSeconds` and `duck`.** `mux_audio` lays one track
  over the whole video at one level: an effect can only start at zero, and a bed loud
  enough to hear buries the voice. Placement is what puts a cue on its frame; `duck` +
  `voiceTrack` is a compressor keyed off the narration, so the bed drops while a line
  plays and comes back between lines without anyone authoring an envelope. Several
  `mux_audio` passes would also re-encode the sound once per pass and mix each layer
  blind to the next.
- **The two drawing passes last.** `overlay_text` and `overlay_image` re-encode the
  picture (they are drawing on it) and copy the audio through, so they belong after the
  mix — the other way round costs a generation of sound quality for nothing. Both take
  every layer in ONE call for the same reason: two passes are two re-encodes of the
  picture. Draw type and artwork in either order; put whichever must sit on top last.

Other patterns the same pieces cover:

- **Stills → motion**: `generate_image` ×N → `video_compose slideshow` (with
  `crossfadeSeconds`) → `mux_audio`. Cheap; no video model involved at all.
- **Variations**: `generate_image count=4` → the user picks one → `generate_image
  images=[picked.png]` to refine it.
- **Repurposing**: `video_compose trim` + `gif` to cut a shareable loop out of a clip.
- **Captions for a vertical platform**: `overlay_text` with one entry per line and
  `fromSeconds`/`toSeconds` per line. Keep them off the frame edge — `marginPx` defaults
  to about 0.8 of the font size, which is not enough clearance for a Shorts/Reels UI
  overlay, so pass a bigger one for anything going to a 9:16 surface.
- **A logo bug, an end card, a lower third**: `overlay_image`. Size it with
  `widthPercent` — a percentage of the *frame* width — never by exporting the art at some
  pixel size, because the same asset then has to work on a 1080p master and a 4K one.
  `opacity` 0.3-0.6 is a watermark; 1 is a logo. A still is looped for the video's length
  automatically, and `eof_action=pass` means a layer shorter than the film (an animated
  sting) doesn't truncate it.
- **Subtitles from a file**: `burn_subtitles` takes an `.srt` or `.vtt` and times every cue
  from the file itself, wrapping to 42 characters and drawing on a plate. Use it rather
  than hand-writing an `overlay_text` entry per line whenever a subtitle file exists — a
  VO script run through any transcriber produces one. It needs no libass: the file is
  parsed here and drawn with the same escaped drawtext path as `overlay_text`, which costs
  italics and per-cue positioning and buys not depending on how the user's ffmpeg was
  built.
- **Effects, plural**: `generate_sfx` is one sound per call by design — the models are
  tuned for a single event and a scene prompt comes out muddy. Generate each hit
  separately, then place them all in one `mix_audio` call.

---

## Privacy — what to say and what not to

Generation is **not** encrypted and cannot be. The prompt, any input image,
and the finished bytes pass through Privateer's servers in plaintext on their way to and
from the model provider. That is what generation *is*.

What we do control, and can say honestly:

- **Nothing is persisted server-side.** The bytes come back inline in the response and
  land only in the file the tool was told to write. This is why the agent gets its own
  route (`/api/agent/media/*`) rather than reusing the developer `/v1` API, which
  uploads results to S3 to hand back a signed URL.
- **The ZDR gate applies.** An account with Require ZDR on cannot be routed to a
  retaining image/video/**sfx**/3D model unless the owner has explicitly enabled non-ZDR
  media. A blocked call returns `ZDR_MEDIA_BLOCKED`; the tool says which setting, whose
  it is to change, and not to retry.
- **Speech runs confidentially** — the account's default TTS model is a
  confidential-compute one.
- **Music does not, and can't.** Neither Lyria SKU has a zero-retention endpoint and no
  confidential music model exists anywhere in the catalog, so music is deliberately
  exempt from the ZDR gate (see `treeview/CLAUDE.md` §5). The mitigation is that the
  request is sent unattributed. `generate_music`'s description says so, and its result
  reminds the model to pass that on. Never call a music prompt private.
- **Sound effects are gated, and this is the pair people get backwards.** Every effect
  model is on fal, which is simply a non-ZDR provider — the exact situation the gate
  exists for — so `/api/audio/sfx` gates like image and video do and a default
  (ZDR-on) account is refused. Music skips the gate only because gating it would leave
  an empty picker. So when an effect is blocked, the honest answer is "your account
  requires ZDR and no effect model offers it"; suggesting `generate_music` instead would
  be routing around a privacy setting to a tool with *no* gate. Both
  `generate_sfx`'s description and `media_capabilities`' report say so, and
  `tests/media.test.ts` asserts they keep saying it.

Never describe a routine that generates media as fully private. Do say the output
isn't stored in our cloud.

---

## The switch

`mediaEnabled()` in `src/config/hosted.ts`, mirroring `webEnabled()`:

- `HARBOR_MEDIA=1` → on (still requires credentials)
- `HARBOR_MEDIA=0` → off
- unset → on once signed in

It is separate from web access because it buys and costs something different: a search
costs a fraction of a cent and sends a query to an index; generation costs up to a
dollar and sends the prompt to a model provider. A hosted agent that should read the
news is not automatically one that should be able to bill for a minute of video.

**Generation only.** `video_compose` is local ffmpeg work on files already on disk — no
account, no network, no spend — and stays registered regardless, so a run can still
finish assembling media a previous run produced.

### Unattended runs must name the tools — and naming them is the authorization

Unlike the web tools, media tools are **not** in the default allow-list for harbor
routines, channels, or ACP, even with the switch on. A routine gets them only by listing
them in its `tools`. That makes "this routine can bill me for video" a decision someone
made rather than a default they inherited.

That naming then has to *mean* something at run time, and until recently it didn't. Every
billing tool is `alwaysAsk` (below), which outranks bypass mode — and an unattended run's
gate has nobody to ask, so it denied. A routine could name `generate_video` and have every
call it made refused: not a safe default so much as a capability that silently didn't
exist.

So the harbor now passes its gate the billing tools **this run's own allow-list names**
(`isSpendPreauthorized`, `src/permissions/modeGate.ts`). That lifts the `alwaysAsk` veto
and nothing else. Four guards, each one load-bearing:

- the run must vouch for the tool **by name** — a grant for `generate_sfx` is not a grant
  for `generate_video`;
- `alwaysAsk` must be the only reason the gate was asking, checked by re-deciding with the
  flag cleared. So plan mode still denies and a default-mode session still prompts:
  pre-authorization never grants what the mode wouldn't;
- **never** when the call leaves the working directory or touches a protected file. Bypass
  mode allows both outright, so this can't lean on the re-decide — "you may generate video"
  must not become "you may upload `~/.ssh/id_rsa` as a reference image";
- never on a remote-driven turn. Someone is holding the phone; they get the prompt.

### Subagents of an unattended run

A subagent is a fresh headless `pi` process, so it inherits nothing but the environment and
the `-e` moat `bin/privateer-subagent.mjs` injects. Two things had to change for "one
subagent per shot" to work at 3am:

1. **The tools have to exist.** `extensions/privateer-media.ts` joined the wrapper's
   fallback moat (the list a child of an in-code parent gets — the harbor, a routine, a
   live task session). It is safe to list unconditionally because the extension shapes
   itself: `video_compose` always registers, and the billing tools register only if this
   child holds a spend grant. An ungated child that got them anyway would spend its whole
   context discovering one refusal at a time.
2. **The grant has to travel.** `src/permissions/childSpend.ts` publishes the run's grant
   as `PRIVATEER_CHILD_SPEND`, which pi-subagents' `{...process.env}` spawn carries down to
   every (nested) child. Read **only** when `PI_SUBAGENT_CHILD=1`, so a stray value in a
   developer's shell can never turn a terminal into one that bills without asking.

The daemon can run two unattended sessions at once, and children read one process-wide
variable when they spawn — so the published value is the **intersection** of every grant in
flight, not the union. Exact when one run holds a grant; narrowing, fail-closed, with the
gate's ordinary denial message, when two overlap. A child denied that way says so; a child
over-granted would bill silently.

### Permission gate

`src/permissions/classify.ts` classifies all eight as writes against their output path, so
they prompt like any other write and are denied in plan/readonly mode. Three details worth
knowing:

- The prompt title names the spend (`Generate a video (billed to your Privateer
  account)`), because "Run generate_video" tells a user nothing about what it costs.
- An **input** path outside the working directory marks the whole call `outside`, even
  when the output lands neatly in cwd — `images: ["~/.ssh/id_rsa.png"]` would upload a
  file from outside scope to our servers, and that has to prompt.
- **Nested input paths are extracted too.** `mix_audio` carries a path inside each entry of
  `tracks`, `overlay_image` inside each entry of `images`, `overlay_text` takes a
  `fontFile` and `burn_subtitles` a `subtitles` file. A path the classifier can't see is a
  path the gate never judges, so `tracks: [{path: "~/.ssh/id_rsa"}]` would otherwise read a
  key from outside scope with `outside` left false. Bare strings are accepted in both lists
  because the tools accept them, and the classifier has to see whatever the tool will open.
  `images` is the awkward one: a list of plain paths for `generate_video`'s reference
  stills and a list of objects for `overlay_image`'s layers, so both shapes resolve.

---

## Server side

`treeview/server/routes/agentMedia.js` → `services/agentMediaHandler.js`, mounted at
`/api/agent/media` (before `/api/agent`, which authenticates everything that reaches it).

```
POST /api/agent/media/images         generate, or edit/compose from input images
POST /api/agent/media/videos         submit an async video job         → 202 { jobId }
GET  /api/agent/media/videos/:jobId  poll; delivers the bytes ONCE, inline
GET  /api/agent/media/capabilities   resolved models, legal durations, ZDR posture
```

Audio has no route here: `/api/audio/speech`, `/api/audio/music` and `/api/audio/sfx`
already take the same JWT and return bytes inline, so the speech, music and effect tools
call them directly. `/capabilities` still reports on sfx, because whether the account is
*allowed* to generate one is not something the agent can work out for itself.

```
POST /api/audio/speech               text → narration (confidential model)
POST /api/audio/music                prompt → a bed. NO ZDR gate (deliberate)
POST /api/audio/sfx                  prompt + duration → one effect. ZDR-gated
```

`/sfx` takes `requireZdr` and `allowNonZdrMedia` in its body, and `generate_sfx`
deliberately sends **neither** — omitted, the server resolves both from the account, which
is the only version of that decision the agent has any business influencing.

It also clamps a duration outside its model's range rather than refusing it, which is
right for a slider and wrong for an agent: a model that asked for 45s and silently got 30
would cut the sequence to a length that does not exist. So `generate_sfx` enforces
1–30 whole seconds locally, before the call.

Three things this route does that its two near-neighbours don't:

1. **No `requireCloudBackend`.** The app's `/api/chat/generate-image` sits behind it, so
   a local-storage account gets a 400 — even though nothing is stored server-side.
2. **Idempotent video polling.** The app's poller de-duplicates completion off a
   `Message.videoAttachment` a CLI job never creates, so every poll after completion
   would re-download and re-settle. This route claims the completion atomically against
   an `ApiMediaJob` row, so the account is charged once however many times the agent
   asks. A second poll gets `{ status: 'completed', delivered: true }` — honest: we did
   make the video, and we kept no copy.
3. **No S3.** Enforced by a test (see below), because the easy refactor is to reuse the
   `/v1` handler and quietly start writing users' media into our bucket.

Billing is at **app rates**, tagged `origin: 'cli'`. `AGENT_CLI_MARKUP_FACTOR` is about
token inference; media pricing funds the media pipeline.

---

## Tests

- `privateer-agent/tests/media.test.ts` — tool-name/registration parity, permission
  classification (including the outside-input case and the nested `tracks[].path` one),
  local validation that never reaches the network, and **real ffmpeg round trips**.
  Skipped where ffmpeg isn't installed. Three of those round trips assert on the OUTPUT
  rather than the exit code, because that is where these graphs actually go wrong:
  - `concat`/`slideshow`/`mux_audio` over the awkward combination a generated-clip
    workflow produces — mixed sizes, mixed frame rates, and a silent clip meeting one
    with audio.
  - `mix_audio` **measured**: `silencedetect` proves a cue placed at 3.2s starts at 3.2s,
    and a bandpass at the bed's own frequency proves `duck` drops it by more than 3 dB
    under the voice (it measures ~6 dB). A mix that merely exits 0 can be silent, or
    quietly a third of the level asked for — which is what `amix` does by default, and
    why the graph passes `normalize=0`.
  - `overlay_text` with a caption containing `:` `,` `%` `'` `;` `[` `]` `\` and a
    `%{pts}` expansion sequence. It passes only because the text reaches drawtext through
    a *file*; that test is the reason not to "simplify" it back to `text=`.
  - `overlay_image` **measured by sampling pixels**: a red mark composited at
    `widthPercent: 20`, `position: top-right` is red at the coordinates that implies, black
    at frame centre, still there at 3.9s of a 4s clip, and a layer at `opacity: 0.5` over
    black measures exactly half red. The "still there at the end" assertion is not padding
    — it is the one that caught the bug below.
  - `burn_subtitles` **measured the same way**: lit during each cue, black in the gap
    between them, and gone after the last. Plus `parseSubtitleCues`/`wrapLines` as pure
    units over SubRip, WebVTT, a BOM, CRLF, backwards timings and `<i>`/`{\an8}` markup.
- `privateer-agent/tests/gate.test.ts` — the pre-authorized-spend guards, one test per
  guard: no grant still denies, a grant covers only the named tool, and it survives
  neither plan mode, nor leaving cwd, nor a protected file, nor an interactive session's
  prompt, nor a driven turn, nor dangerous shell.
- `privateer-agent/tests/childSpend.test.ts` — the parent→child hand-down, including the
  intersection under two overlapping runs and the fact that the env var does nothing
  outside a subagent child.
- `treeview/server/test/mediaZdrEnforcement.test.js` — extended with an
  `agentMediaHandler` section: every `generateImage` call threads `requireZdr`, both
  handlers gate on `assertMediaModelAllowed`, the image fallback model is re-gated, and
  the handler never uploads to S3.

## Not done

- Never run against the live server. The routes, the ZDR gate wiring and the billing
  path are typechecked, lint-clean and covered by structural tests, but no real image,
  video or sound effect has been generated through `/api/agent/media/*` or
  `/api/audio/sfx` **from the agent**. The ffmpeg half (`video_compose`, including the
  two new operations) is exercised end to end for real, because it needs no account.
- The app has no UI for the `HARBOR_MEDIA` per-agent switch yet — hosted agents get the
  default (on when signed in) until `tenantEnv` sets it the way it sets `HARBOR_WEB`.
- The parent approval relay is still only started by the TUI (`extensions/privateer-gate.ts`)
  and the REPL, so a subagent of a **live task** session — where the app IS attached and
  could answer — has no channel to ask over, and the `subagent` tool is blocked outright on
  a driven turn anyway (`REMOTE_UNSAFE_TOOLS`). Unattended fan-out works because the grant
  removes the need to ask; driven fan-out still needs the relay wired.
- **A wart in `mux_audio`, left alone deliberately:** its `keepOriginalAudio` mix uses
  `amix` at the default `normalize=1`, which halves both tracks, so `volume=0.3` does not
  mean 0.3 of the original level. `dynaudnorm` afterwards partly masks it. `mix_audio`
  does not have this problem (`normalize=0` + a limiter). Fixing `mux_audio` would change
  the output of existing calls, so it wants its own change — prefer `mix_audio` for
  anything where the balance matters.

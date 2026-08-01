# Media generation — images, video, speech, music

The agent can create media through the signed-in Privateer account and assemble it
locally with ffmpeg. Six tools, one server route, and a switch.

Nothing here is BYO-key: every generation call is billed to the user's Privateer
subscription over the session token the terminal already holds, so no provider key ever
sits in the environment for a prompt-injected run to read out.

---

## The tools

| Tool | What it does | Costs |
|---|---|---|
| `generate_image` | Text → image, or edit/compose from images already on disk | cents per image |
| `generate_video` | Text → video clip; optional first/last frame stills | ~$0.10–$1 per clip |
| `generate_speech` | Text → spoken audio (narration) | fractions of a cent |
| `generate_music` | Text → instrumental audio (a score) | ~$0.04–$0.08 per call |
| `media_capabilities` | What this account can do right now | free |
| `video_compose` | Local ffmpeg: probe, concat, slideshow, mux_audio, trim, extract_frame, gif | free |

Every tool takes an explicit output `path` and returns it. That is what makes a
*workflow* possible rather than a one-shot: the file each step writes is the file the
next step reads.

### Where they live

- `src/tools/media.ts` — the five account-backed tools (`MEDIA_TOOL_NAMES`)
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
video_compose   mux_audio  input=cut.mp4  audio=audio/vo.mp3 → narrated.mp4
generate_music  prompt="warm ambient pad, 70bpm"      → audio/score.mp3
video_compose   mux_audio  input=narrated.mp4  audio=audio/score.mp3
                keepOriginalAudio=true  volume=0.3  loopAudio=true → final.mp4
```

`extract_frame at="last"` → `generate_video firstFrame=…` is the load-bearing step. Video
models have no memory between calls, so without it consecutive clips look like unrelated
shots. With it they read as one continuous take.

Other patterns the same pieces cover:

- **Stills → motion**: `generate_image` ×N → `video_compose slideshow` (with
  `crossfadeSeconds`) → `mux_audio`. Cheap; no video model involved at all.
- **Variations**: `generate_image count=4` → the user picks one → `generate_image
  images=[picked.png]` to refine it.
- **Repurposing**: `video_compose trim` + `gif` to cut a shareable loop out of a clip.

---

## Privacy — what to say and what not to

Generation is **not** end-to-end encrypted and cannot be. The prompt, any input image,
and the finished bytes pass through Privateer's servers in plaintext on their way to and
from the model provider. That is what generation *is*.

What we do control, and can say honestly:

- **Nothing is persisted server-side.** The bytes come back inline in the response and
  land only in the file the tool was told to write. This is why the agent gets its own
  route (`/api/agent/media/*`) rather than reusing the developer `/v1` API, which
  uploads results to S3 to hand back a signed URL.
- **The ZDR gate applies.** An account with Require ZDR on cannot be routed to a
  retaining image/video model unless the owner has explicitly enabled non-ZDR media.
  A blocked call returns `ZDR_MEDIA_BLOCKED`; the tool says which setting, whose it is
  to change, and not to retry.
- **Speech runs confidentially** — the account's default TTS model is a
  confidential-compute one.
- **Music does not, and can't.** Neither Lyria SKU has a zero-retention endpoint and no
  confidential music model exists anywhere in the catalog, so music is deliberately
  exempt from the ZDR gate (see `treeview/CLAUDE.md` §5). The mitigation is that the
  request is sent unattributed. `generate_music`'s description says so, and its result
  reminds the model to pass that on. Never call a music prompt private.

Never describe a routine that generates media as private end-to-end. Do say the output
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

### Unattended runs must name the tools

Unlike the web tools, media tools are **not** in the default allow-list for harbor
routines, channels, or ACP, even with the switch on. A routine gets them only by listing
them in its `tools`. That makes "this routine can bill me for video" a decision someone
made rather than a default they inherited.

### Permission gate

`src/permissions/classify.ts` classifies all six as writes against their output path, so
they prompt like any other write and are denied in plan/readonly mode. Two details worth
knowing:

- The prompt title names the spend (`Generate a video (billed to your Privateer
  account)`), because "Run generate_video" tells a user nothing about what it costs.
- An **input** path outside the working directory marks the whole call `outside`, even
  when the output lands neatly in cwd — `images: ["~/.ssh/id_rsa.png"]` would upload a
  file from outside scope to our servers, and that has to prompt.

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

Audio has no route here: `/api/audio/speech` and `/api/audio/music` already take the
same JWT and return bytes inline, so the speech and music tools call them directly.

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
  classification (including the outside-input case), local validation that never
  reaches the network, and a **real ffmpeg round trip** over the awkward combination a
  generated-clip workflow actually produces: mixed sizes, mixed frame rates, and a
  silent clip meeting one with audio. Skipped where ffmpeg isn't installed.
- `treeview/server/test/mediaZdrEnforcement.test.js` — extended with an
  `agentMediaHandler` section: every `generateImage` call threads `requireZdr`, both
  handlers gate on `assertMediaModelAllowed`, the image fallback model is re-gated, and
  the handler never uploads to S3.

## Not done

- Never run against the live server. The route, the ZDR gate wiring and the billing
  path are typechecked, lint-clean and covered by structural tests, but no real image
  or video has been generated through `/api/agent/media/*`.
- The app has no UI for the `HARBOR_MEDIA` per-agent switch yet — hosted agents get the
  default (on when signed in) until `tenantEnv` sets it the way it sets `HARBOR_WEB`.

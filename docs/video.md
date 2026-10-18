# Product videos (`video-mcp/`)

_The mechanism behind `builtin:video`, and the failure each rule is there to prevent._

A product demo is not generated; it is **built** from a document the agent and the person keep
editing. "Make me a demo video" as one prompt gives one video nobody can steer — the narration
is a beat too long, the click is too fast, the third step shows the wrong screen, and the only
remedy is to roll the dice again. So the unit of work is `storyboard.json`, the video is its
build, and every rule below exists to make *edit → look → edit* cheap enough to repeat
ten times.

The pipeline used to record the flow and render every frame in one call, so any edit — a caption,
a zoom, a card's wording — regenerated everything. Now **capture and narration produce assets;
a persistent Remotion project (the studio) plays them live; an export is a Remotion render of that
same composition.** Everything that is not the screen recording (cards, captions, zoom, typing
sound, narration mix, progress bar) lives in the composition, so editing it costs nothing.

`video-mcp/` is its own package (`daedalus-video-mcp`, stdio, `@modelcontextprotocol/sdk`). It is
not a library the server imports: the harness reaches it only as an MCP server a thread links
(`builtin:video`), and it runs fine standalone against any MCP client.

## The video folder and the storyboard

```
<project cwd>/.daedalus/videos/<name>/
  storyboard.json     tracked in git - capture + narration source of truth
  .gitignore          "node_modules/\n.cache/\nout/\nstudio/public/\nstudio/props.json\n"
  studio/             the Remotion project, scaffolded ONCE from video-mcp/templates/studio
    package.json tsconfig.json src/ scripts/render.mjs
    public/           GENERATED per build: video.<ext> (hard link or copy of the capture),
                      a<N>.<ext> narration, click.wav when any step typed
    props.json        GENERATED per build: StudioProps (below). Root.tsx imports it
  .cache/             tts/ capture/ jobs/ studio.json studio.log build.json timeline.json locked.json
  out/                <name>-draft.mp4 <name>-final.mp4 (+ -part) contact-sheet.png report.json stills/
```

- **The storyboard is the only capture-side thing worth committing**, and the agent edits it with
  its ordinary file tools, not a tool call per field. A tool call per edit would be a second API
  over a JSON file the model already edits well, and the person could not read the diff.
  `video_init` makes the folder; nothing else writes the storyboard except
  `video_import_recorder` (and only with `overwrite`).
- **`studio/` is the person's after the first scaffold.** `scaffoldStudio` copies only files that
  do not exist, so a composition the person edited is never overwritten by a later `video_init`
  or build. `video_build {resetStudio:true}` is the one door that re-copies `src/` **and
  `scripts/`** from the template (`render.mjs` is half of the render contract, so a reset that
  left an old one beside a new composition would split it) and discards their edits.
  `public/` and `props.json` are generated and gitignored: a clone rebuilds them.
- **A name is a folder, never a path** (`/^[a-z0-9][a-z0-9-]{0,63}$/`), and every path derived
  from it or from the storyboard (`file`) goes through `inside()`, which refuses to leave the
  video folder. The name comes from a model; `../x` must not create anything.
- **The project is the client's first MCP root, else `process.cwd()`.** The harness gives a stdio
  MCP no cwd of its own, so what decides it is the agent runtime's cwd for the child (the thread's
  `threadCwd`) - see "Not verified".
- **Schema is strict where an agent could typo.** A step has `id`, `say`, `do`, `hold`, `zoom`,
  `voice`, `overlay`, `at`, `chapter`, `locked`. A Playwright-style action rejects unknown keys
  (`selectr` is an error, not a silent no-op that records a video of nothing happening); a Recorder
  step is loose, because real exports carry `target`, `frame`, `timeout`, `assertedEvents` that we
  do not execute. Both shapes are accepted because the Chrome DevTools Recorder is how a person
  gets a flow without writing selectors (`video_import_recorder`), and the Playwright shape is what
  an agent writes by hand.
- **A step is one beat.** Narration (`say`) and the actions (`do`) that happen under it are the
  same step because that is the unit a person reacts to ("step 3 is too fast"). A step is at least
  as long as its narration (`audioMs + hold + 250ms slack`, 400ms hold by default, 1200ms when
  silent) so the picture never cuts the voice off.
- **`locked: true` freezes a step the person approved.** The first build records the step's hash
  in `.cache/locked.json`; a later build whose hash differs **fails with the step named**, rather
  than quietly re-recording something the person signed off on. Unlock by removing the flag (the
  flag itself is not part of the hash, so locking and unlocking never count as an edit). Deleting
  a locked step also fails, for the same reason.

## `props.json`: the one data contract

The build turns the capture and the narration into `StudioProps` (`src/studio-props.ts`, mirrored as
a plain type in the template because the template cannot import from the package):
`{width, height, fps, durationMs, video, easeMs, click?, scenes[]}`, a scene being a `card` (intro
or chapter) or a `clip` with `srcMs` (where it starts in the capture), `audio`, `zoom` (a crop
window in video pixels), `overlay`, `caption` and `keys` (typing ticks relative to the clip).

- **All times are on the composition's own clock, not the capture's.** An intro card (2400 ms) and
  a chapter card (1800 ms) before a step that has `chapter` push every later step down, so a step's
  start in `build.json`, `report.json` and `video_export {scene}` is the composition's, and
  `srcMs` is the only place the capture's clock survives. Reading a step's time off the recording
  is wrong by every card before it. A clip and its chapter card carry `stepId`; the intro does not.
- **The composition reads it by import** (`import props from '../props.json'`), which is what makes
  a build hot-reload an open Studio: the file changes, the bundler rebuilds. A placeholder with
  `scenes: []` is scaffolded so Studio opens before the first build.
- Frames are `round(ms/1000 * fps)`. Hand-made fades (`@remotion/transitions` is not installed in
  the shared `node_modules`; nothing installs it for you) apply only where a card meets a clip or
  another card; two clips in a row stay one continuous recording.
- **Drawing assumes the capture is the composition's size**, because `zoom.x/y/w` are in video
  pixels.

## The loop

1. **Edit** `storyboard.json` (or `video_init` / `video_import_recorder` the first time).
2. **Build** - `video_build` returns `{jobId}` at once, `video_job` polls. A build is capture +
   narration, which takes as long as the flow does and so is longer than a tool call may block: a
   job in memory, mirrored to `.cache/jobs/<id>.json`, and a job whose server restarted reads back
   as `failed: interrupted`, never as forever-running. Stages: validate, tts, capture, timeline,
   assets (write `public/` + `props.json`), studio (ensure it is running). **No render**: the
   result is the build info and `{studio: {url, port, running}}`. One running build per video
   (two would race on the same cache directories), also across processes: `.cache/build.lock`
   (pid + job id) refuses a second build with the holder named; a lock whose pid is dead is taken
   over. A Studio that fails to start is a build **warning**, not a failure - the assets are good
   and `video_studio start` retries.
3. **Watch** - open the Studio URL: the video plays, hot-reloaded, with no render. Edit
   `studio/src` (the look) or `props.json` and the preview moves with no rebuild.
4. **Review** - `video_review` writes `out/contact-sheet.png` and `out/report.json` and returns both,
   the sheet inline. It needs no mp4: it renders **one still per scene** (the mid-frame of each clip,
   each card one cell) through `render.mjs --mode still`, one bundle for all frames, tiled by ffmpeg
   with id, timing and narration burned in. This is how the agent *sees* the result without a video
   player. The `out/stills/` directory is cleared on every review.
5. **Ask** - the agent states what it changed and what it noticed, and asks before a final.
6. **Export** - `video_export` (draft by default) renders the composition to `out/<name>-<quality>.mp4`;
   `quality: "final"` only once the person agrees.
7. **Publish** - `video_publish` puts the export in the Files library, on request.

## What re-runs when

| Stage | Key | Reused when |
| --- | --- | --- |
| TTS, per step | `sha256(say, voice, tts provider id, TTS settings that change the audio)` | the line, voice and provider are unchanged - **edits elsewhere never re-synthesise it**. Costs real money with a paid provider, which is why it is keyed per line and survives step reordering and insertion. |
| Capture, whole flow | `sha256(capture provider id, "draft", viewport, baseUrl, file stat, every step's id/actions/zoom/at/**minDurationMs**)` | no step's actions or minimum duration changed |
| Composition | none | it is not a stage: `studio/src`, `props.json` and the cards/captions/overlay/zoom *drawing* are live in Studio and cost only an export |
| Export | none | never cached; it is the render, and its inputs are the whole composition |

- **The capture key's quality is the constant `"draft"`**: there is one capture now, and keeping
  the literal in the key is what kept every existing cache entry valid across the redesign. Do not
  change anything that goes into the key without meaning to invalidate every capture.
- **Changing a line's words usually re-records.** `minDurationMs` includes the narration's length,
  so any rewording moves it (a real TTS never returns the same millisecond count for different
  words), every later step's marks move, and capture re-runs. Only an `overlay` change leaves the
  capture key alone. A `zoom` edit *does* (it is a capture
  input: the provider reads the target's rect). Editing the composition's drawing of a zoom (the
  ease, the scale curve) does not.
- **Inserting or removing a step re-records** (the step list is in the key) but every other line's
  audio is still a hit.
- **`force: ["tts"|"capture"]`** ignores a cache, for "the page changed under me".
- Cache entries store paths relative to the video folder, so moving or committing the folder does
  not invalidate them.

**Capture runs the whole flow, never a step.** Browser state is sequential - step 3's button exists
because step 2 clicked something - so a single step cannot be re-recorded in isolation without
checkpoints of the page. `ponytail:` no per-step checkpoints; the upgrade, and the next step of this
design, is recording per step against a deterministic starting state.

## Studio

`video_studio {name, action: start|stop|status}` manages one `remotion studio src/index.ts --port N
--no-open` child per video, started by `video_build` too.

- **Detached, so it survives an MCP restart** (the thread that built the video is not the one the
  person is watching it in); state is `.cache/studio.json` (`pid, port, host, url, startedAtIso`),
  log `.cache/studio.log`. `stop` kills the process group - a studio is a node tree - and removes
  the file. `status` is **pid alive AND the port answers**: a pid is reused and a recycled one
  would report a dead Studio as running.
- **Port**: the first free in 3100-3199, starting at a stable offset derived from the name, so
  two videos do not fight over a port and a restarted Studio tends to come back at the same URL.
  Start is idempotent and gives up with the log tail after 90 s (a first start bundles).
- **Loopback only, and that is enforced rather than asked for.** Studio can write files into the
  project and start renders, and **Remotion has no host option** - `--host` is ignored and it
  listens on every interface. Started plainly, anyone on the LAN could drive it. So `startStudio`
  preloads a shim (generated into `.cache/studio-host.cjs` by `src/remotion.ts`, not part of the template) through `NODE_OPTIONS`, which rewrites a wildcard bind to
  `VIDEO_STUDIO_HOST` (default `127.0.0.1`); a test checks the LAN address refuses. **Setting
  `VIDEO_STUDIO_HOST=0.0.0.0` hands that file-write and render surface to the network**, with no
  auth of any kind - do it only on a network you trust. The shim is rewritten on every start.
- Spawned with argv arrays, never a shell string. Chrome is `findChrome()`, passed as
  `browserExecutable`.

## Export, and the one place Remotion's API is touched

`templates/studio/scripts/render.mjs` is the only code that talks to `@remotion/bundler` and
`@remotion/renderer`; `src/remotion.ts` (`spawnRender`) runs it as a child with cwd = `studio/` and
parses its stdout. Flags: `--mode still|media --props <file> --out <path> [--frames a-b]
[--frame n,n,n] [--quality draft|final] [--chrome <path>] [--concurrency n]`. It bundles **once**
(the bundle, not the frames, is the cost: ~25 s for a handful of stills), then `renderMedia`
(h264 + the composition's own aac) or `renderStill` per listed frame. Stdout is one JSON object per
line - `{"progress":0..1}`, then `{"done":true,"out":...}` or `{"error":msg}` with exit 1 - and the
error is the Error's message only, never an env value.

- **draft = crf 28, final = crf 18**, same composition. A draft is for judging pace; the final
  is not "sharper" than the capture (the recording is at viewport size either way).
- **A fragment is not the export.** `scene: <stepId>` (that step's card + clip) and `frames: "a-b"`
  (inclusive, composition frames) write `out/<name>-<quality>-part.mp4`, so a quick look at one
  step never truncates the last full render and `video_publish` can only ever upload the real one.
  A full export renders to a `*.tmp.mp4` beside the target and **renames on success**: a render that
  fails halfway leaves the last good file alone.
- Validation (props has scenes, the capture is in `public/`, the range is valid) happens before the
  job starts, so a bad range is an error, not a failed job.
- A job is `video_job` like a build, and one export per video can run beside one build.

## Tools

`video_init` (storyboard + `.gitignore` + scaffolded studio; scaffolds first and *then* errors with
the install line if Remotion is not resolvable), `video_providers` (capture + tts readiness plus a
`remotion {installed, version?, hint}` block), `video_build`, `video_studio`, `video_export`,
`video_job` (build and export), `video_review`, `video_publish`, `video_list` (studio running +
exported mp4s), `video_import_recorder`.

## Providers and configuration

Two seams, each a `Record` in `src/providers/registry.ts` (one import line, one entry). Providers
declare **capabilities as data** (`headless`, `cursor`, `wordTimestamps`, `needsKey`) and the
pipeline reads those; **it never compares a provider id** - the same bargain the agent registry
makes (`docs/architecture.md`). There is no render seam: rendering is Remotion's, in the studio,
and there is one renderer to keep honest instead of three.

Configuration is **environment variables of the MCP process**; there is deliberately no settings UI.
Per-video, `storyboard.providers` overrides (`capture`, `tts`).

| Seam | Providers | Env |
| --- | --- | --- |
| capture | `playwright` (default), `file` | `VIDEO_CAPTURE`, `VIDEO_CHROME_PATH`, `VIDEO_CAPTURE_OFFSET_MS`, `VIDEO_ALLOW_FILE_URLS`, `VIDEO_IGNORE_HTTPS_ERRORS` |
| tts | `silent`, `openai-compatible`, `elevenlabs` | `VIDEO_TTS`, `VIDEO_TTS_BASE_URL`, `VIDEO_TTS_API_KEY`, `VIDEO_TTS_MODEL`, `VIDEO_TTS_VOICE`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` |
| studio / export | Remotion (packages in `<project>/.daedalus/videos/node_modules`) | `VIDEO_REMOTION_CMD`, `VIDEO_STUDIO_HOST`, `VIDEO_TYPING_SOUND` (`0` off), `VIDEO_TYPING_SOUND_FILE` |

- **TTS defaults to `silent` when nothing is configured**, `openai-compatible` when a base URL is
  set, `elevenlabs` when only its key is. Silent writes a real silent track of the length the words
  would take (`max(900ms, words x 320ms)`), so timing, captions and cache behave exactly as with a
  voice and the person can approve pacing before paying for audio.
- **`openai-compatible`** is `POST {base}/v1/audio/speech` (OpenAI's shape), which covers OpenAI and
  self-hosted Kokoro-FastAPI. The base may or may not end in `/v1`.
- **`video_providers` says what is *configured right now*, never a key.** A provider that is
  registered but not ready answers with the variable to set. `READINESS` in `config.ts` has one
  entry per provider id, and `build` asks it first so a missing key is one sentence up front, not a
  401 from the middle of a capture.
- **No key value ever leaves the process.** Every error, log line, job file and tool result goes
  through `redact()`, and child processes (`ffmpeg`, `render.mjs`, Studio, Chromium) are not handed
  the TTS keys. The smoke test echoes the credential back in an upstream 500 and scans every tool
  result and every file under `.daedalus/` for it.
- **Capture records through Playwright's screencast, not `recordVideo`.** `recordVideo`'s clock
  starts at the first paint, which moved video t=0 by up to ~500ms between identical runs; marks
  taken against it were wrong by that much. The screencast reports its first frame's timestamp, and
  a mark is `now - firstFrame`. `VIDEO_CAPTURE_OFFSET_MS` is the calibration knob left for another
  machine (default 0, measured with `test/calibrate.mjs`).
  An action that cannot run (a selector that matches nothing in 3s) is a **warning on that step**,
  not a failed build - the contact sheet then shows the page as it was and `video_review` names the
  step. It needs Playwright's own ffmpeg once: `npx playwright-core install ffmpeg`.
- **`goto` is http(s) only.** `file:` needs `VIDEO_ALLOW_FILE_URLS=1`; link-local addresses
  (169.254/16, fe80::/10) and the cloud metadata host are always refused, after resolving the name,
  as a step warning. HTTPS errors are enforced unless `VIDEO_IGNORE_HTTPS_ERRORS=1`. A redirect onto a
  link-local address is not caught (ponytail: needs `route.fetch` with `maxRedirects: 0`).
- **`file` capture without `at`**: steps with no `at` share the span between their neighbours' known
  starts evenly, and say "timing inferred" as a warning. Give `at` for exact marks.
- **Typing has a sound, and the composition mixes it.** A `type` action records the time of every
  keystroke on its step's mark (`keys`); the build synthesises a 40 ms tick once (`makeClick`,
  `src/audio.ts`, to `public/click.wav`) and the composition lays it on each key with a per-key
  `playbackRate` and `volume` (`keyJitter`) in Remotion's `Audio`. `fill` is instant and silent.
  A capture cached before this has no `keys`: `force: ["capture"]` re-records it.
- **ffmpeg's remaining jobs**: probing, the typing tick, and the review sheet's tiles. It renders
  no video.
- **Licence.** Remotion is free for individuals and small teams and paid above that; the install
  message says so, and the harness installs nothing for you (`notInstalledMessage`). Check the
  terms before using it for a company.

## The builtin shim (`builtin:video`)

- **It is a library row, not a profile toggle** (`BUILTIN_MCP.video`, "Product videos"), like the
  harness and browser rows; `videoServer` in `server/src/sessions.ts` resolves it at spawn.
- **The child is `node <repo>/video-mcp/dist/index.js`** — located from `import.meta.url`, so it is
  the same under tsx and from `dist/` — with `HARNESS_URL` = the thread's loopback (`/hm/<key>/<id>`)
  and every `VIDEO_*` / `ELEVENLABS_*` variable of the *server's* env. Providers are configured where
  the server runs, never per thread. Nothing else of the server's env reaches it.
  **Every child the MCP spawns** (ffmpeg, `render.mjs`, Studio, Chromium) gets its env **without** `HARNESS_URL`,
  `VIDEO_TTS_API_KEY`, `ELEVENLABS_API_KEY` and `VIDEO_TTS_BASE_URL`, and errors, jobs and `build.json`
  are redacted of those values and of any `/hm/<key>/` segment.
- **A tool that cannot answer is not advertised.** No `ffmpeg` on PATH or no built
  `video-mcp/dist` and the row resolves to nothing (one `[mcp]` log line), exactly as the browser row
  does without Chrome. The fix is `pnpm build` in `video-mcp/`.
- **Top-level threads only** — a workflow step or a subagent does not get it. A demo is a
  conversation with a person; a step with nobody in front of it has nobody to ask.
- **`video_publish` rides the loopback.** The proxy re-dispatches `/api/*` with the server bearer
  attached, and it forwards `x-filename` (and no other caller header) because a raw
  `POST /api/files` carries its name in that header and nothing else.

## The Files-library cap and publishing

The Files library refuses anything over `MAX_FILE_BYTES` = 25 MB (413). That is why `video_export`
warns in its result when a file is over the cap, and why `video_publish` checks **before**
uploading: over the cap it says so and tells the agent to export a draft or shorten the video; a 413
from the server gets the same answer. It uploads only the full `out/<name>-<quality>.mp4` (never a
`-part`); with the file missing it says to run `video_export`. It finds-or-creates
`Videos/<folder or name>`, uploads first and **deletes the old same-named file only after the upload
succeeds** (the server keeps both as `name (2)`, so the new row is renamed back; a failed delete or
rename is a warning), as raw bytes. With `HARNESS_URL` unset (standalone) nothing is requested; it
returns the local path and says the Files library needs the harness.

Publish when the person has accepted an export or asked for the file, not after every export - the
library is a shared place, and re-publishing replaces, but each upload is up to 25 MB.

## Known limits

- **Capture re-runs the whole flow** (above). A 10-step demo re-records all ten for a one-step edit
  that changes timing. Per-step capture is the next step.
- **The Studio URL is on the machine the MCP runs on, loopback only.** The harness's Preview panel
  (and a browser on another device) may not reach `127.0.0.1:31xx` of the server, and widening it
  with `VIDEO_STUDIO_HOST` is the risk named under "Studio". How the person reaches the port (a
  desktop shell on the same host, a tunnel) is unsolved here; the contact sheet and an exported mp4
  work regardless.
- **A first Studio start and every review pay a bundle** (tens of seconds). Review batches all its
  frames into one bundle for that reason; a Studio keeps its own bundle warm.
- **`@remotion/transitions` is not installed**, so fades are hand-made; installing it is a
  deliberate act, not something the build does.
- **Drawing assumes the capture is the composition's size.** A viewport that differs from
  `width x height` in `props.json` crops wrongly rather than scaling.
- **ElevenLabs was exercised only against a mocked `fetch`** of the documented response shape.
  `openai-compatible` only against a local mock server (a real mp3 made by ffmpeg).
- **Iframes are not entered** by the capture provider; shadow-root selector chains work. Real SPAs,
  strict-CSP pages and unusual `<select>` markup were not tried; only the local fixture was.
- **No settings UI** - provider choice and keys are env on the server process.
- **No playback in the app.** The Preview panel does not play the mp4; the person opens the file
  (`out/<name>-<quality>.mp4`, or the Files library after publish) or the Studio themselves. The
  contact sheet is the agent's eyes, not the person's player.

## Not verified

The harness side was checked by unit test (the resolved server definition, the header forwarding,
the gating) and never by a real thread calling a tool. In particular unconfirmed: that the agent
runtimes start a stdio MCP child in the thread's cwd (it matters, because the video folder lands in
the child's cwd unless the client offers MCP roots), and that `POST /api/files` accepts the raw body
the way the mock does.

## Tests

`cd video-mcp && pnpm build`, then `node test/core.test.mjs` (the props layout, export ranges,
scaffold, and a real Studio start/status/stop with a check that it does not listen on the LAN).
`test/publish.test.mjs` covers publish. `smoke.mjs`, `ffmpeg.test.mjs`, `web-render.test.mjs` and
`review.test.mjs` still describe the removed render seam and `pnpm test` is red until they are
rewritten; `pnpm test:capture` (real Chromium, Playwright's ffmpeg) is separate. The server side is
`pnpm test:harness` (`builtin:video` block).

# video-mcp file ownership

Build: `pnpm build` (tsc to dist/), `pnpm check`, `pnpm test` (needs a build first; `test/core.test.mjs` is the current core test; `smoke.mjs`, `ffmpeg.test.mjs`, `web-render.test.mjs`, `review.test.mjs` still reference the removed render seam and need rewriting; `pnpm test:capture` is separate).
Prerequisites: ffmpeg + ffprobe on PATH, a Chromium (see `findChrome`), once `npx playwright-core install ffmpeg` (Playwright's screencast needs its own build), and Remotion (`remotion`, `react`, `react-dom`, `@remotion/cli`, `@remotion/bundler`, `@remotion/renderer`) resolvable from `<project>/.daedalus/videos/` (not a dependency of this package). Docs: `/docs/video.md`, agent instructions: `SKILL.md`.
A builder overwrites ONLY the files it owns and keeps every exported name and provider `id`.
Shared files (contract) are not edited by builders; if one needs a change, say so in your result.

| File | Owner |
| --- | --- |
| package.json, tsconfig.json, .gitignore, pnpm-lock.yaml | contract |
| src/types.ts, src/studio-props.ts (`StudioProps`, `INTRO_MS`, `CARD_MS`), src/storyboard.ts, src/config.ts, src/exec.ts, src/cache.ts, src/jobs.ts, src/timeline.ts, src/pipeline.ts | contract |
| src/providers/registry.ts (capture + tts only), src/index.ts, src/server.ts | contract |
| src/audio.ts (`makeClick`, `keyJitter`), src/remotion.ts (Studio lifecycle, `spawnRender`, install checks), src/scaffold.ts (`scaffoldStudio`, `exportRange`, `sceneStills`) | core |
| templates/studio/ (package.json, tsconfig.json, props.json placeholder, src/*.tsx, scripts/render.mjs) | composition |
| src/providers/capture/playwright.ts (`playwrightCapture`), actions.ts (`normalizeAction`, `NormalizedAction`), file.ts (`fileCapture`) | capture |
| src/providers/tts/openai-compatible.ts, elevenlabs.ts, silent.ts, probe.ts (`probeDurationMs`) | tts |
| src/tools/studio.ts (`studioTool`), src/tools/export.ts (`startExport`), src/tools/review.ts (`reviewVideo`), src/tools/publish.ts (`publishVideo`), src/recorder-import.ts (`importRecorder`) | tools |
| test/core.test.mjs | core |
| test/smoke.mjs | contract (stale: still the old render seam) |
| server/src/ (BUILTIN_MCP `video` row, harness.ts `x-filename` forwarding) | server-shim |
| docs/video.md, SKILL.md, FILES.md | docs |

`templates/studio/` is copied, never imported: the template mirrors `StudioProps` as `src/types.ts`, so a change to
`src/studio-props.ts` is a change to both. `render.mjs` is the only code that touches Remotion's Node API.

## Conventions the pipeline relies on

- Provider `id` equals its key in `registry.ts`. The pipeline never compares ids; it reads `capabilities`.
- Per-video paths come from `videoPaths()` (`storyboard.ts`); user-supplied relative paths go through `inside()`.
- `findChrome()` (config.ts) is how the capture provider gets an executable: `VIDEO_CHROME_PATH`, else the newest
  `chromium-<rev>` in `~/.cache/ms-playwright` (cache holds 1243; playwright-core 1.64 wants 1248, so always pass
  `executablePath` to `chromium.launch`), else system chrome.
- Child processes: `run(cmd, argv, opts)` from `exec.ts`; errors are redacted. `splitCommand()` for `VIDEO_*_CMD`.
- Capture marks: `startMs`/`endMs` are in the recorded video's own timeline (0 = first frame). The provider must honour each
  step's `minDurationMs` and return `targetRect` in video pixels for steps with `zoom`. Relative urls resolve against `baseUrl`.
- TTS: `synth` receives `outPath` without extension and returns the real path; pipeline caches under `.cache/tts/<key>`.
  Return `durationMs` (pipeline falls back to `probeDurationMs` if it is not a positive number). `words` is optional.
- No render provider: the build ends at `studio/public/` + `studio/props.json` (times on the composition clock, cards included);
  `video_export` and `video_review` run `studio/scripts/render.mjs` through `spawnRender`. Capture quality in the cache key is the
  constant `"draft"`; do not change anything that goes into `captureKey`.
- `.cache/build.json` (`BuildInfo`), `.cache/timeline.json` (`Timeline`) and `studio/props.json` are what review reads.

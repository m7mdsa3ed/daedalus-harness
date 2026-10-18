import { statSync } from "node:fs";
import { copyFile, link, mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { keyJitter, makeClick } from "./audio.js";
import { captureGet, capturePut, captureReset, readJson, ttsGet, ttsOutBase, ttsPut, writeJson } from "./cache.js";
import { redact } from "./exec.js";
import { assertConfigured, captureOffsetMs, findChrome, ttsFingerprint } from "./config.js";
import { resolveProviders } from "./providers/registry.js";
import { probeDurationMs } from "./providers/tts/probe.js";
import { startStudio } from "./remotion.js";
import { scaffoldStudio } from "./scaffold.js";
import { actionsOf, ensureDirs, inside, loadStoryboard, sha256, stepHash, videoPaths, type Storyboard, type VideoPaths } from "./storyboard.js";
import { CARD_MS, INTRO_MS, ZOOM_EASE_MS, type Scene, type StudioProps } from "./studio-props.js";
import { buildTimeline, type TimelineStep } from "./timeline.js";
import type { BuildInfo, CaptureStepInput, Force, Quality, Stage, StepInfo, StudioInfo, Timeline, TtsResult } from "./types.js";

export interface BuildArgs {
  cwd: string;
  name: string;
  force?: Force[];
  /** Re-copy studio/src and studio/scripts from the template (discards edits to them). */
  resetStudio?: boolean;
  /** Passed in so a build is reproducible and testable; the caller owns the clock. */
  startedAtIso: string;
  onProgress?: (stage: Stage, fraction: number) => void;
  signal?: AbortSignal;
}

// One capture serves preview and export, so the key carries a constant; changing it would invalidate every cached recording.
const CAPTURE_QUALITY: Quality = "draft";
const SLACK_MS = 250;
const DEFAULT_HOLD_MS = 400;
const SILENT_STEP_MS = 1200;

/**
 * A locked step is frozen: the first build records its hash, any later difference fails the
 * build. Unlock by removing "locked" from the step (and build once before deleting it).
 */
export async function enforceLocks(p: VideoPaths, sb: Storyboard): Promise<void> {
  // Maps, not objects: a step id may be "constructor" or "__proto__", which a plain object would mistake for its own members.
  const raw = await readJson<unknown>(p.lockedFile);
  const stored = new Map<string, string>(raw && typeof raw === "object" ? Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string") : []);
  const next = new Map<string, string>();
  const problems: string[] = [];
  for (const s of sb.steps) {
    if (!s.locked) continue;
    const h = stepHash(s);
    const was = stored.get(s.id);
    if (was && was !== h) problems.push(`locked step "${s.id}" was edited`);
    next.set(s.id, was ?? h);
  }
  const ids = new Set(sb.steps.map((s) => s.id));
  for (const id of stored.keys()) if (!ids.has(id)) problems.push(`locked step "${id}" was removed`);
  if (problems.length)
    throw new Error(`${problems.join("; ")}. Restore it, or remove "locked" from the step to unlock it (build once before deleting it).`);
  // Object.fromEntries defines own properties, so a "__proto__" key is written as data, not as a prototype.
  const same = next.size === stored.size && [...next].every(([k, v]) => stored.get(k) === v);
  if (!same) await writeJson(p.lockedFile, Object.fromEntries(next));
}

/** Cheap and never launches a browser: the executable's path plus its size and mtime. */
export function chromeIdentity(): string {
  const path = findChrome();
  const st = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
  return `${path ?? ""}:${st?.size ?? ""}:${st?.mtimeMs ?? ""}`;
}

/**
 * What a recording depends on. Zoom contributes only its selector (it decides targetRect); its scale is applied
 * later, in the timeline, so changing it must not re-record. The offset and the browser change where marks land.
 */
export function captureKey(o: { providerId: string; quality: Quality; sb: Pick<Storyboard, "viewport" | "baseUrl" | "file">; steps: CaptureStepInput[]; fileStat?: { size: number; mtimeMs: number }; offsetMs: number; chrome: string }): string {
  const steps = o.steps.map((s) => ({ ...s, zoom: s.zoom ? { selector: s.zoom === true ? null : (s.zoom.selector ?? null) } : null }));
  return sha256("capture", o.providerId, o.quality, o.sb.viewport, o.sb.baseUrl ?? "", o.sb.file ?? "", o.fileStat ? [o.fileStat.size, o.fileStat.mtimeMs] : "", o.offsetMs, o.chrome, steps);
}

export async function build(a: BuildArgs): Promise<BuildInfo> {
  const say = (stage: Stage, f: number) => a.onProgress?.(stage, f);
  const force = new Set(a.force ?? []);
  const p = videoPaths(a.cwd, a.name);

  // 1. validate
  say("validate", 0.01);
  const sb = await loadStoryboard(p);
  if (!sb.steps.length) throw new Error("the storyboard has no steps");
  await enforceLocks(p, sb);
  const prov = resolveProviders(sb);
  await assertConfigured("capture", prov.capture.id);
  await assertConfigured("tts", prov.tts.id);
  if (sb.file) inside(p.dir, sb.file);
  await ensureDirs(p);
  await scaffoldStudio(p.dir, { reset: a.resetStudio });

  // 2. tts (sequential: providers rate-limit, and identical lines then hit the cache)
  const audio = new Map<string, { r: TtsResult; key: string; hit: boolean }>();
  const withSay = sb.steps.filter((s) => s.say?.trim());
  for (const [i, s] of withSay.entries()) {
    a.signal?.throwIfAborted();
    say("tts", 0.05 + (0.25 * i) / withSay.length);
    const voice = s.voice ?? sb.voice;
    const key = sha256("tts", s.say, voice ?? "", prov.tts.id, ttsFingerprint());
    let r = force.has("tts") ? undefined : await ttsGet(p, key);
    const hit = !!r;
    if (!r) {
      r = await prov.tts.synth({ text: s.say!, voice, outPath: ttsOutBase(p, key) });
      if (!Number.isFinite(r.durationMs) || r.durationMs <= 0) r = { ...r, durationMs: await probeDurationMs(r.path) };
      await ttsPut(p, key, r);
    }
    audio.set(s.id, { r, key, hit });
  }

  // 3. capture: one run covers the whole flow, because browser state is sequential
  // ponytail: no per-step checkpoints, so one edited step re-records the video
  const steps: CaptureStepInput[] = sb.steps.map((s) => {
    const audioMs = audio.get(s.id)?.r.durationMs;
    const minDurationMs = audioMs !== undefined ? audioMs + (s.hold ?? DEFAULT_HOLD_MS) + SLACK_MS : s.hold !== undefined ? s.hold + SLACK_MS : SILENT_STEP_MS;
    return { id: s.id, minDurationMs, actions: actionsOf(s), zoom: s.zoom, at: s.at };
  });
  const fileStat = sb.file ? await stat(inside(p.dir, sb.file)).catch(() => undefined) : undefined;
  // ponytail: the browser is part of the key even for providers that never launch one (a Chrome update re-records a file capture too)
  const capKey = captureKey({ providerId: prov.capture.id, quality: CAPTURE_QUALITY, sb, steps, fileStat, offsetMs: captureOffsetMs(Number.NaN), chrome: chromeIdentity() });
  say("capture", 0.3);
  let capture = force.has("capture") ? undefined : await captureGet(p, capKey);
  const capHit = !!capture;
  if (!capture) {
    a.signal?.throwIfAborted();
    const dir = await captureReset(p, capKey);
    capture = await prov.capture.capture({ storyboard: sb, steps, dir, videoDir: p.dir, signal: a.signal });
    await capturePut(p, capKey, capture);
  }

  // 4. timeline
  say("timeline", 0.7);
  const tlSteps: TimelineStep[] = sb.steps.map((step) => ({ step, audio: audio.get(step.id)?.r }));
  const { timeline, warnings: stepWarnings } = buildTimeline(capture, tlSteps, sb.title);
  await writeJson(p.timelineFile, timeline);

  // 5. assets: what the composition reads. Studio hot-reloads when props.json changes, so it is written last.
  say("assets", 0.8);
  const { props, stepTimes, assets } = buildStudioProps(timeline, { typingSound: process.env.VIDEO_TYPING_SOUND !== "0" });
  await writeAssets(p, assets, !!props.click);
  await writeJson(p.propsFile, props);

  // 6. studio: a build that cannot start it is still a build (the assets are there, video_studio can retry)
  say("studio", 0.9);
  const warnings = [...capture.warnings];
  let studio: StudioInfo;
  try {
    a.signal?.throwIfAborted();
    studio = await startStudio(p);
  } catch (e) {
    studio = { running: false };
    warnings.push(`Studio is not running: ${e instanceof Error ? e.message : String(e)}`);
  }

  const perStep: StepInfo[] = timeline.clips.map((c) => {
    const t = audio.get(c.stepId);
    return {
      id: c.stepId,
      tts: t ? (t.hit ? "hit" : "miss") : "none",
      ttsKey: t?.key,
      audioMs: t?.r.durationMs ?? 0,
      // on the composition's clock: cards shift a step from where it was captured
      startMs: stepTimes[c.stepId].startMs,
      endMs: stepTimes[c.stepId].endMs,
      warnings: (stepWarnings[c.stepId] ?? []).map(redact),
    };
  });
  const info: BuildInfo = {
    startedAtIso: a.startedAtIso,
    providers: { capture: prov.capture.id, tts: prov.tts.id },
    perStep,
    capture: capHit ? "hit" : "miss",
    durationMs: props.durationMs,
    studio,
    warnings: warnings.map(redact), // build.json is read by the agent; a provider warning may quote a loopback URL
    totals: {
      steps: perStep.length,
      durationMs: props.durationMs,
      audioMs: perStep.reduce((n, s) => n + s.audioMs, 0),
      ttsHits: perStep.filter((s) => s.tts === "hit").length,
      ttsMisses: perStep.filter((s) => s.tts === "miss").length,
    },
  };
  await writeJson(p.buildFile, info);
  say("done", 1);
  return info;
}

/**
 * The timeline laid out on the composition's own clock: an intro card, then each step's clip behind its chapter card
 * (if it has one). Pure, so the layout is testable without a browser. `assets` lists what must sit under public/.
 */
export function buildStudioProps(t: Timeline, o: { typingSound?: boolean } = {}): { props: StudioProps; stepTimes: Record<string, { startMs: number; endMs: number }>; assets: { name: string; from: string }[] } {
  const video = `video${extname(t.video.path) || ".mp4"}`;
  const assets = [{ name: video, from: t.video.path }];
  const chapters = t.clips.filter((c) => c.chapter).length;
  const scenes: Scene[] = [];
  const stepTimes: Record<string, { startMs: number; endMs: number }> = {};
  let at = 0;
  if (t.title) {
    scenes.push({ type: "card", kind: "intro", fromMs: at, durMs: INTRO_MS, text: t.title });
    at += INTRO_MS;
  }
  let n = 0;
  let typed = false;
  for (const c of t.clips) {
    if (c.chapter) {
      scenes.push({ type: "card", kind: "chapter", stepId: c.stepId, fromMs: at, durMs: CARD_MS, n: ++n, total: chapters, text: c.chapter });
      at += CARD_MS;
    }
    const durMs = c.endMs - c.startMs;
    const s: Scene = { type: "clip", stepId: c.stepId, fromMs: at, durMs, srcMs: c.startMs };
    if (c.audio) {
      const name = `a${assets.length - 1}${extname(c.audio.path) || ".mp3"}`;
      assets.push({ name, from: c.audio.path });
      s.audio = { file: name, durationMs: c.audio.durationMs };
    }
    if (c.zoom) s.zoom = { x: c.zoom.x, y: c.zoom.y, w: c.zoom.w, scale: c.zoom.scale };
    if (c.overlay) s.overlay = c.overlay;
    // The captions inside this clip, which the pill shows (one per step unless the TTS gave word times).
    const inside = t.captions.filter((k) => k.startMs >= c.startMs && k.startMs < c.endMs);
    if (inside.length) s.caption = { text: inside.map((k) => k.text).join(" "), endMs: inside[inside.length - 1].endMs - c.startMs };
    if (o.typingSound !== false && c.keys?.length) {
      typed = true;
      s.keys = c.keys.map((k, i) => ({ t: k - c.startMs, ...keyJitter(i) }));
    }
    scenes.push(s);
    stepTimes[c.stepId] = { startMs: at, endMs: at + durMs };
    at += durMs;
  }
  const props: StudioProps = { width: t.width, height: t.height, fps: t.fps, durationMs: at, video, easeMs: ZOOM_EASE_MS, click: typed ? "click.wav" : undefined, scenes };
  return { props, stepTimes, assets };
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to); // another filesystem
  }
}

/** Fills studio/public with this build's files and removes the ones an earlier build left that this one does not use. */
async function writeAssets(p: VideoPaths, assets: { name: string; from: string }[], click: boolean): Promise<void> {
  await mkdir(p.publicDir, { recursive: true });
  for (const a of assets) await linkOrCopy(a.from, join(p.publicDir, a.name));
  if (click) await makeClick(join(p.publicDir, "click.wav"), p.publicDir);
  const keep = new Set([...assets.map((a) => a.name), ...(click ? ["click.wav"] : [])]);
  // only names we generate: the person may keep their own files (fonts, logos) in public/
  for (const f of await readdir(p.publicDir)) if (/^(video\.|a\d+\.|click\.wav$)/.test(f) && !keep.has(f)) await rm(join(p.publicDir, f), { force: true });
}

import type { Step } from "./storyboard.js";
import type { CaptureResult, Rect, Timeline, TimelineClip, TtsResult } from "./types.js";

export interface TimelineStep {
  step: Step;
  audio?: TtsResult;
}

const DEFAULT_ZOOM = 1.6;
const WORDS_PER_CAPTION = 8;

/** Crop window of the video's aspect, `scale` times tighter than the frame, centred on the target and kept inside the frame. */
function zoomWindow(target: Rect, width: number, height: number, scale: number): NonNullable<TimelineClip["zoom"]> {
  const w = width / scale;
  const h = height / scale;
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const x = Math.min(Math.max(cx - w / 2, 0), width - w);
  const y = Math.min(Math.max(cy - h / 2, 0), height - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), scale };
}

/** Marks + audio into the one structure every renderer reads. Audio starts where its step starts. */
export function buildTimeline(capture: CaptureResult, steps: TimelineStep[], title?: string): { timeline: Timeline; warnings: Record<string, string[]> } {
  const warnings: Record<string, string[]> = {};
  const clips: TimelineClip[] = [];
  const captions: Timeline["captions"] = [];

  for (const { step, audio } of steps) {
    const mark = capture.marks.find((m) => m.stepId === step.id);
    if (!mark) throw new Error(`capture returned no mark for step "${step.id}"`);
    const w = (warnings[step.id] = [...mark.warnings]);
    const clip: TimelineClip = { stepId: step.id, startMs: mark.startMs, endMs: mark.endMs };
    if (mark.keys?.length) clip.keys = mark.keys;
    if (step.chapter) clip.chapter = step.chapter;

    if (audio) {
      clip.audio = { path: audio.path, durationMs: audio.durationMs };
      clip.caption = step.say;
      if (audio.durationMs > mark.endMs - mark.startMs) w.push(`audio (${audio.durationMs}ms) is longer than the step (${mark.endMs - mark.startMs}ms)`);
      if (audio.words?.length) {
        for (let i = 0; i < audio.words.length; i += WORDS_PER_CAPTION) {
          const g = audio.words.slice(i, i + WORDS_PER_CAPTION);
          captions.push({ startMs: mark.startMs + g[0].startMs, endMs: mark.startMs + g[g.length - 1].endMs, text: g.map((x) => x.text).join(" ") });
        }
      } else if (step.say) {
        // ponytail: one caption per step; wrapping long narration is the renderer's problem
        captions.push({ startMs: mark.startMs, endMs: mark.startMs + audio.durationMs, text: step.say });
      }
    }

    if (step.zoom) {
      if (mark.targetRect) clip.zoom = zoomWindow(mark.targetRect, capture.width, capture.height, (step.zoom === true ? undefined : step.zoom.scale) ?? DEFAULT_ZOOM);
      else w.push("zoom requested but the capture found no target to frame");
    }
    if (step.overlay) clip.overlay = { text: step.overlay.text, position: step.overlay.position ?? "bottom" };
    clips.push(clip);
  }

  return {
    timeline: { title, width: capture.width, height: capture.height, fps: capture.fps, durationMs: capture.durationMs, video: { path: capture.videoPath }, clips, captions },
    warnings,
  };
}

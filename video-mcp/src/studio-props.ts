// The one data contract between the pipeline and the Remotion composition (studio/props.json).
// Pure types and timing constants: templates/studio mirrors the types by hand, it cannot import from here.

export const INTRO_MS = 2400;
export const CARD_MS = 1800;
export const ZOOM_EASE_MS = 450;

/** All times are ms on the composition's own clock (cards included), not the capture's. */
export interface Scene {
  type: "card" | "clip";
  fromMs: number;
  durMs: number;
  /** The step this scene belongs to (a chapter card and its clip share it; the intro has none). Lets an export or review pick a step's range. */
  stepId?: string;
  /** card */
  kind?: "intro" | "chapter";
  n?: number;
  total?: number;
  text?: string;
  /** clip: where it starts in the capture video, and what plays over it (all relative to the clip's start). */
  srcMs?: number;
  audio?: { file: string; durationMs: number };
  /** Crop window in video pixels. */
  zoom?: { x: number; y: number; w: number; scale: number };
  overlay?: { text: string; position: string };
  caption?: { text: string; endMs: number };
  keys?: { t: number; rate: number; vol: number }[];
}

export interface StudioProps {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** File names under studio/public/. */
  video: string;
  easeMs: number;
  click?: string;
  scenes: Scene[];
}

export const msToFrame = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

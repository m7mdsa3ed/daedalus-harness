import type { Action, Storyboard, Step } from "./storyboard.js";

export type Quality = "draft" | "final";
export type Force = "tts" | "capture";
export type ProviderKind = "capture" | "tts";
/** Build stages, then the one an export job reports. */
export type Stage = "validate" | "tts" | "capture" | "timeline" | "assets" | "studio" | "export" | "done";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- capture ----------------------------------------------------------------

export interface CaptureStepInput {
  id: string;
  /** The step must last at least this long (narration + hold + slack). */
  minDurationMs: number;
  actions: Action[];
  zoom?: Step["zoom"];
  /** capture "file" only: where this step starts in the recorded file. */
  at?: number;
}

export interface CaptureInput {
  storyboard: Storyboard;
  steps: CaptureStepInput[];
  /** Scratch dir the provider may write into; it is the cache entry. */
  dir: string;
  /** The video folder, for providers that read a file the author put there (capture "file"). */
  videoDir: string;
  signal?: AbortSignal;
}

export interface CaptureMark {
  stepId: string;
  startMs: number;
  endMs: number;
  /** In video pixels. The element a zoom should frame (zoom.selector, else the last target acted on). */
  targetRect?: Rect;
  /** Keystroke times (ms, the capture clock) of the step's `type` actions: what typing sound is laid on. */
  keys?: number[];
  warnings: string[];
}

export interface CaptureResult {
  videoPath: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  marks: CaptureMark[];
  warnings: string[];
}

export interface CaptureProvider {
  id: string;
  capabilities: { headless: boolean; cursor: boolean };
  capture(input: CaptureInput): Promise<CaptureResult>;
}

// ---- tts --------------------------------------------------------------------

export interface TtsWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TtsInput {
  text: string;
  voice?: string;
  /** Without extension: the provider picks it and returns the real path. */
  outPath: string;
}

export interface TtsResult {
  path: string;
  durationMs: number;
  words?: TtsWord[];
}

export interface TtsProvider {
  id: string;
  capabilities: { wordTimestamps: boolean; needsKey: boolean };
  synth(input: TtsInput): Promise<TtsResult>;
}

// ---- timeline (capture marks + narration; studio-props.ts lays it out on the composition clock) ----

export interface TimelineClip {
  stepId: string;
  startMs: number;
  endMs: number;
  audio?: { path: string; durationMs: number };
  /** Crop window in video pixels, same aspect as the video. */
  zoom?: { x: number; y: number; w: number; h: number; scale: number };
  /** Keystroke times (ms, on the video's clock), from the capture's marks. */
  keys?: number[];
  /** Title card text shown before the step. */
  chapter?: string;
  overlay?: { text: string; position: "top" | "bottom" | "center" };
  caption?: string;
}

export interface Timeline {
  /** The storyboard's title: an intro card. */
  title?: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  video: { path: string };
  clips: TimelineClip[];
  captions: { startMs: number; endMs: number; text: string }[];
}

// ---- build report (.cache/build.json) ---------------------------------------

export interface StepInfo {
  id: string;
  tts: "hit" | "miss" | "none";
  ttsKey?: string;
  audioMs: number;
  /** On the composition's clock: cards shift a step from where it was captured. */
  startMs: number;
  endMs: number;
  warnings: string[];
}

export interface StudioInfo {
  url?: string;
  port?: number;
  running: boolean;
}

export interface BuildInfo {
  startedAtIso: string;
  providers: { capture: string; tts: string };
  perStep: StepInfo[];
  capture: "hit" | "miss";
  /** Composition length in ms (intro and chapter cards included). */
  durationMs: number;
  studio: StudioInfo;
  warnings: string[];
  totals: { steps: number; durationMs: number; audioMs: number; ttsHits: number; ttsMisses: number };
}

// ---- jobs -------------------------------------------------------------------

export type JobKind = "build" | "export";

export interface JobState {
  id: string;
  name: string;
  kind: JobKind;
  /** Exports only. */
  quality?: Quality;
  status: "running" | "done" | "failed";
  stage: Stage;
  progress: number;
  startedAtIso: string;
  /** The MCP process running it: another process's live job is not an interrupted one. */
  pid?: number;
  /** BuildInfo for a build, the export summary for an export. */
  result?: unknown;
  error?: string;
}

// ---- review / publish (owned by review-publish) ------------------------------

export interface ReviewArgs {
  cwd: string;
  name: string;
  /** Limit the sheet and report to these steps; default all. */
  stepIds?: string[];
}

export interface ReviewStep {
  id: string;
  say?: string;
  audioMs: number;
  stepMs: number;
  startMs: number;
  endMs: number;
  warnings: string[];
}

/** One cell of the contact sheet: a card or a step's clip, on the composition's clock. */
export interface ReviewScene {
  index: number;
  type: "card" | "clip";
  kind?: "intro" | "chapter";
  stepId?: string;
  fromMs: number;
  durMs: number;
  /** The composition frame the still was taken at. */
  frame: number;
}

export interface ReviewReport {
  name: string;
  /** Composition length (ms), cards included. */
  durationMs: number;
  scenes: ReviewScene[];
  steps: ReviewStep[];
  warnings: string[];
}

export interface ReviewResult {
  contactSheetPath: string;
  reportPath: string;
  report: ReviewReport;
}

export interface PublishArgs {
  cwd: string;
  name: string;
  quality: Quality;
  /** Library folder name under "Videos"; default is the video name. */
  folder?: string;
  /** Test seam; default config.harnessUrl(). */
  harnessUrl?: string;
}

export interface PublishResult {
  published: boolean;
  path: string;
  sizeBytes: number;
  fileId?: string;
  /** Library path, e.g. "Videos/demo". */
  folder?: string;
  /** Plain-language outcome the agent can relay (also says why when published is false). */
  message: string;
}

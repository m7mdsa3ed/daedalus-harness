// Mirror of video-mcp's src/studio-props.ts (this project cannot import from the package). Times are ms on this
// composition's own clock; a build rewrites ../props.json, which Root.tsx imports so Studio hot-reloads.
export type Scene = {
  type: "card" | "clip";
  fromMs: number;
  durMs: number;
  // card
  kind?: "intro" | "chapter";
  n?: number;
  total?: number;
  text?: string;
  // clip: where it starts in the capture video, and what plays over it (relative to the clip's start)
  srcMs?: number;
  audio?: { file: string; durationMs: number };
  zoom?: { x: number; y: number; w: number; scale: number };
  overlay?: { text: string; position: string };
  caption?: { text: string; endMs: number };
  keys?: { t: number; rate: number; vol: number }[];
};

export type StudioProps = {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  video: string;
  easeMs: number;
  click?: string;
  scenes: Scene[];
};

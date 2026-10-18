export const FONT = "Inter, 'SF Pro Display', system-ui, 'Segoe UI', Roboto, sans-serif";
export const ACCENT = "#8b5cf6";
export const ACCENT_2 = "#22d3ee";
export const BASE = "#0b1020";
export const BG = "linear-gradient(135deg, #0b1020 0%, #151a3a 55%, #1d1744 100%)";
export const RULE = `linear-gradient(90deg, ${ACCENT}, ${ACCENT_2})`;
export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const FADE_MS = 300;

export const toFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, clamp } from "../theme";

// Narration as a floating pill that springs up and fades away at endMs (relative to the clip).
export const Pill = ({ text, endMs, size }: { text: string; endMs: number; size: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = spring({ frame, fps, config: { damping: 15, stiffness: 140 } });
  const out = interpolate((frame / fps) * 1000, [endMs - 250, endMs + 150], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: "4.5%", fontFamily: FONT, opacity: Math.min(inn, out) }}>
      <span style={{ maxWidth: "78%", textAlign: "center", color: "#fff", fontSize: size, fontWeight: 600, padding: "0.5em 1.1em", borderRadius: 999, background: "rgba(15,18,40,0.72)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 14px 40px rgba(0,0,0,0.35)", transform: `translateY(${(1 - inn) * 26}px)` }}>{text}</span>
    </AbsoluteFill>
  );
};

// The step's on-screen label (top | center | bottom). The AbsoluteFill is a column: justifyContent is the vertical axis.
export const Label = ({ text, where, size }: { text: string; where: string; size: number }) => {
  const pos: Record<string, object> = { top: { justifyContent: "flex-start", paddingTop: "6%" }, center: { justifyContent: "center" }, bottom: { justifyContent: "flex-end", paddingBottom: "14%" } };
  return (
    <AbsoluteFill style={{ display: "flex", alignItems: "center", fontFamily: FONT, ...(pos[where] ?? pos.center) }}>
      <span style={{ maxWidth: "80%", textAlign: "center", color: "#fff", background: "rgba(15,18,40,0.72)", borderRadius: 14, padding: "0.35em 0.8em", fontSize: size, fontWeight: 700 }}>{text}</span>
    </AbsoluteFill>
  );
};

import { AbsoluteFill } from "remotion";
import { BG } from "./theme";

// Gradient with two glows that drift with the frame.
export const Backdrop = ({ frame }: { frame: number }) => (
  <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
    <div style={{ position: "absolute", width: 720, height: 720, borderRadius: "50%", left: -160 + frame * 1.4, top: -260 + Math.sin(frame / 40) * 40, background: "radial-gradient(circle, rgba(139,92,246,0.45), rgba(139,92,246,0) 65%)" }} />
    <div style={{ position: "absolute", width: 640, height: 640, borderRadius: "50%", right: -180 - frame * 1.2, bottom: -260 + Math.cos(frame / 45) * 40, background: "radial-gradient(circle, rgba(34,211,238,0.30), rgba(34,211,238,0) 65%)" }} />
  </AbsoluteFill>
);

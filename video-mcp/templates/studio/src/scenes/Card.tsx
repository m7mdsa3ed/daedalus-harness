import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../Backdrop";
import { ACCENT_2, FONT, RULE, clamp } from "../theme";
import type { Scene, StudioProps } from "../types";

// Title card: spring-in number and headline, and a rule that draws itself. Fading in/out is Demo's.
export const Card = ({ s, p }: { s: Scene; p: StudioProps }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 110 } });
  const enter2 = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 110 } });
  const rule = interpolate(frame, [4, 22], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const intro = s.kind === "intro";
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Backdrop frame={frame} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 10%" }}>
        {!intro && (
          <div style={{ color: ACCENT_2, fontSize: p.height * 0.034, fontWeight: 700, letterSpacing: "0.32em", opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}>
            {`STEP ${String(s.n).padStart(2, "0")} / ${String(s.total).padStart(2, "0")}`}
          </div>
        )}
        <div style={{ width: p.width * 0.12 * rule, height: 5, borderRadius: 3, margin: "22px 0 26px", background: RULE }} />
        <div style={{ color: "#fff", fontSize: p.height * (intro ? 0.105 : 0.09), fontWeight: 800, lineHeight: 1.08, letterSpacing: "-0.02em", opacity: enter2, transform: `translateY(${(1 - enter2) * 36}px) scale(${0.96 + 0.04 * enter2})`, maxWidth: "88%" }}>{s.text}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

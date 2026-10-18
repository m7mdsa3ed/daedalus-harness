import type { ReactNode } from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Card } from "./scenes/Card";
import { Clip } from "./scenes/Clip";
import { BASE, FADE_MS, RULE, clamp, toFrames } from "./theme";
import type { StudioProps } from "./types";

// Fades only where the look changes (to or from a card); two clips in a row are one continuous recording.
const Fade = ({ inn, out, children }: { inn: boolean; out: boolean; children: ReactNode }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig(); // inside a Sequence: this scene's own length
  const f = Math.min(toFrames(FADE_MS, fps), Math.floor(durationInFrames / 3));
  const a = inn ? interpolate(frame, [0, f], [0, 1], clamp) : 1;
  const b = out ? interpolate(frame, [durationInFrames - f, durationInFrames], [1, 0], clamp) : 1;
  return <AbsoluteFill style={{ opacity: Math.min(a, b) }}>{children}</AbsoluteFill>;
};

export const Demo = (p: StudioProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const at = (t: number) => toFrames(t, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: BASE }}>
      {p.scenes.map((s, i) => {
        const prev = p.scenes[i - 1], next = p.scenes[i + 1];
        const edge = (o?: { type: string }) => !!o && (o.type === "card" || s.type === "card");
        return (
          <Sequence key={i} from={at(s.fromMs)} durationInFrames={Math.max(1, at(s.fromMs + s.durMs) - at(s.fromMs))}>
            <Fade inn={edge(prev)} out={edge(next)}>
              {s.type === "card" ? <Card s={s} p={p} /> : <Clip s={s} p={p} />}
            </Fade>
          </Sequence>
        );
      })}
      <div style={{ position: "absolute", left: 0, top: 0, height: 5, width: `${(frame / durationInFrames) * 100}%`, background: RULE }} />
    </AbsoluteFill>
  );
};

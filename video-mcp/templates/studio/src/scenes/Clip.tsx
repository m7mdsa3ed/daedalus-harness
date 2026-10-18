import { AbsoluteFill, Easing, Html5Audio, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../Backdrop";
import { clamp, toFrames } from "../theme";
import type { Scene, StudioProps } from "../types";
import { Label, Pill } from "./Pill";

// The recording in a rounded, shadowed window on the backdrop, the camera easing into the zoom target,
// with narration, typing ticks, label and caption on top. Everything but the video is cheap to edit.
export const Clip = ({ s, p }: { s: Scene; p: StudioProps }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const at = (t: number) => toFrames(t, fps);
  let scale = 1, tx = 0, ty = 0;
  if (s.zoom) {
    const ease = Math.min(p.easeMs, s.durMs / 3);
    const k = interpolate(ms, [0, ease, s.durMs - ease, s.durMs], [0, 1, 1, 0], { ...clamp, easing: Easing.inOut(Easing.ease) });
    const z = p.width / s.zoom.w;
    scale = 1 + (z - 1) * k;
    tx = -s.zoom.x * z * k;
    ty = -s.zoom.y * z * k;
  }
  const settle = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <Backdrop frame={frame + s.fromMs / 40} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", width: p.width, height: p.height, overflow: "hidden", borderRadius: 26, background: "#fff", boxShadow: "0 40px 100px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.10)", transform: `scale(${0.9 + 0.03 * settle})` }}>
          <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
            <OffthreadVideo src={staticFile(p.video)} trimBefore={at(s.srcMs ?? 0)} muted style={{ width: p.width, height: p.height, objectFit: "contain" }} />
          </div>
        </div>
      </AbsoluteFill>
      {s.audio && (
        <Sequence from={0} durationInFrames={Math.max(1, at(Math.min(s.audio.durationMs, s.durMs)))}>
          <Html5Audio src={staticFile(s.audio.file)} />
        </Sequence>
      )}
      {p.click && (s.keys ?? []).map((k, i) => (
        <Sequence key={i} from={at(k.t)} durationInFrames={Math.max(3, at(90))}>
          <Html5Audio src={staticFile(p.click)} volume={k.vol} playbackRate={k.rate} />
        </Sequence>
      ))}
      {s.overlay && <Label text={s.overlay.text} where={s.overlay.position} size={p.height * 0.05} />}
      {s.caption && <Pill text={s.caption.text} endMs={s.caption.endMs} size={p.height * 0.036} />}
    </AbsoluteFill>
  );
};

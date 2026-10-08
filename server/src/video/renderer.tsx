import React from "react";
import { Audio, Composition, registerRoot, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { VideoDocument } from "./schema.js";

function VideoComposition({ document }: { document: VideoDocument }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let start = 0;
  const index = document.scenes.findIndex((scene) => {
    const end = start + Math.ceil(scene.durationSeconds * fps);
    const active = frame >= start && frame < end;
    start = end;
    return active;
  });
  const scene = document.scenes[Math.max(0, index)];
  const sceneStart = document.scenes.slice(0, Math.max(0, index)).reduce((sum, item) => sum + Math.ceil(item.durationSeconds * fps), 0);
  return (
    <div style={{ width: "100%", height: "100%", background: scene.background, color: "#f4f1e8", display: "flex", flexDirection: "column", justifyContent: "center", padding: 88, fontFamily: "Georgia, serif" }}>
      <div style={{ fontSize: 28, letterSpacing: 5, textTransform: "uppercase", opacity: 0.7 }}>{document.title}</div>
      <div style={{ fontSize: 76, lineHeight: 1.08, marginTop: 34 }}>{scene.title || document.title}</div>
      {scene.narration && <div style={{ fontFamily: "Arial, sans-serif", fontSize: 28, marginTop: 36, maxWidth: 1000, opacity: 0.82 }}>{scene.narration}</div>}
      {scene.audioFile && <Sequence from={sceneStart}><Audio src={staticFile(scene.audioFile)} /></Sequence>}
    </div>
  );
}

function Root() {
  return (
    <Composition
      id="DaedalusVideo"
      component={VideoComposition}
      durationInFrames={300}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{ document: { title: "Video", width: 1280, height: 720, scenes: [{ id: "scene-1", title: "Video", narration: "", durationSeconds: 10, background: "#17211e" }] } as VideoDocument }}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.ceil(props.document.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) * 30),
        width: props.document.width,
        height: props.document.height,
      })}
    />
  );
}

registerRoot(Root);

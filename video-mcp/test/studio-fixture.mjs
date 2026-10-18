// A real studio folder in a temp project: scaffolded from the template, the shared Remotion node_modules linked in,
// a generated 320x180 capture and narration under public/, and the props buildStudioProps lays out for them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStudioProps } from "../dist/pipeline.js";
import { missingRemotionPackages } from "../dist/remotion.js";
import { scaffoldStudio } from "../dist/scaffold.js";
import { ensureDirs, videoPaths } from "../dist/storyboard.js";

export const SHARED_MODULES = "/var/www/daedalus-harness/.daedalus/videos/node_modules";

export const timeline = (video, audio) => ({
  title: "Fixture", width: 320, height: 180, fps: 10, durationMs: 3000, video: { path: video },
  clips: [
    { stepId: "a", startMs: 0, endMs: 1500, chapter: "First", keys: [200, 400], audio: { path: audio, durationMs: 1000 }, caption: "hello", zoom: { x: 0, y: 0, w: 160, h: 90, scale: 2 }, overlay: { text: "Hi", position: "top" } },
    { stepId: "b", startMs: 1500, endMs: 3000 },
  ],
  captions: [{ startMs: 0, endMs: 1000, text: "hello there" }],
});

/** Returns {root, p, props, remotion}; remotion is false (and nothing is rendered) when the packages do not resolve. */
export async function makeStudio(name = "fx") {
  const root = mkdtempSync(join(tmpdir(), "video-studio-"));
  const videos = join(root, ".daedalus", "videos");
  mkdirSync(videos, { recursive: true });
  symlinkSync(SHARED_MODULES, join(videos, "node_modules"));
  const p = videoPaths(root, name);
  await ensureDirs(p);
  await scaffoldStudio(p.dir);
  const video = join(p.dir, "cap.webm");
  const audio = join(p.dir, "tone.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "3", "-c:v", "libvpx", video]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
  const { props, assets } = buildStudioProps(timeline(video, audio), { typingSound: false });
  for (const a of assets) execFileSync("cp", [a.from, join(p.publicDir, a.name)]);
  writeFileSync(p.propsFile, JSON.stringify(props));
  return { root, p, props, video, audio, remotion: missingRemotionPackages(p.studioDir).length === 0 };
}

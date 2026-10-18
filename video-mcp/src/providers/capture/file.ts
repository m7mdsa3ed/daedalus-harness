import { stat } from "node:fs/promises";
import { run } from "../../exec.js";
import { inside } from "../../storyboard.js";
import type { CaptureMark, CaptureProvider, CaptureResult } from "../../types.js";

/** A pre-recorded file (screen capture, Loom export...): nothing is driven, steps are slices of it by `at`. */
export const fileCapture: CaptureProvider = {
  id: "file",
  capabilities: { headless: true, cursor: false },
  async capture({ storyboard, steps, videoDir }): Promise<CaptureResult> {
    if (!storyboard.file) throw new Error('capture provider "file" needs a "file" in the storyboard (path relative to the video folder)');
    const path = inside(videoDir, storyboard.file);
    await stat(path).catch(() => {
      throw new Error(`recorded file not found: ${storyboard.file}`);
    });
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", path]);
    const j = JSON.parse(stdout) as { streams?: { width: number; height: number; avg_frame_rate: string }[]; format: { duration?: string } };
    const s = j.streams?.[0];
    if (!s) throw new Error(`${storyboard.file} has no video stream`);
    const durationMs = Math.round(Number(j.format.duration) * 1000);
    const [n, d] = s.avg_frame_rate.split("/").map(Number);
    const fps = d && n / d > 0 ? Math.round(n / d) : 25;

    const warnings: string[] = [];
    if (steps.some((st) => st.actions.length)) warnings.push('"do" actions are ignored with the "file" capture provider');
    // A step's start is its "at". Steps without one share the span from the previous start (or 0) to the next "at"
    // (or the file's end) evenly with that previous step; each ends where the next begins, the last at the file's end.
    const count = steps.length;
    const starts: (number | undefined)[] = steps.map((st) => (st.at === undefined ? undefined : Math.min(st.at, durationMs)));
    const inferred = new Set<number>();
    for (let i = 0; i < count; ) {
      if (starts[i] !== undefined) { i++; continue; }
      let j = i;
      while (j < count && starts[j] === undefined) j++;
      const from = i > 0 ? starts[i - 1]! : 0;
      const to = Math.max(from, j < count ? starts[j]! : durationMs);
      const slots = j - i + (i > 0 ? 1 : 0);
      for (let m = i; m < j; m++) {
        starts[m] = Math.round(from + ((to - from) * (m - i + (i > 0 ? 1 : 0))) / slots);
        if (slots > 1) inferred.add(m);
      }
      i = j;
    }
    const marks: CaptureMark[] = steps.map((st, i) => {
      const w: string[] = [];
      const startMs = starts[i]!;
      if (st.at !== undefined && st.at > durationMs) w.push(`"at" ${st.at}ms is past the end of the file (${durationMs}ms)`);
      if (inferred.has(i)) w.push(`no "at": timing inferred (evenly shared with the neighbouring steps); set "at" to place it exactly`);
      const next = starts[i + 1];
      const endMs = next === undefined ? durationMs : Math.max(startMs, Math.min(next, durationMs));
      if (endMs <= startMs) w.push('zero length: give this step an "at" before the next one\'s, or the previous step already runs to the end');
      return { stepId: st.id, startMs, endMs, warnings: w };
    });
    if (inferred.size) warnings.push(`${inferred.size} step(s) have no "at": their timing was inferred by dividing the recorded file evenly`);
    return { videoPath: path, width: s.width, height: s.height, fps, durationMs, marks, warnings };
  },
};

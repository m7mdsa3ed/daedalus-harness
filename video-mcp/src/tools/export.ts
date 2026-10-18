import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "../cache.js";
import { MAX_FILE_BYTES } from "../config.js";
import { startJob } from "../jobs.js";
import { spawnRender } from "../remotion.js";
import { exportRange } from "../scaffold.js";
import { videoPaths } from "../storyboard.js";
import type { StudioProps } from "../studio-props.js";
import type { Quality } from "../types.js";

export interface ExportArgs {
  cwd: string;
  name: string;
  quality?: Quality;
  /** Inclusive "a-b" in composition frames. */
  frames?: string;
  /** A step id: its chapter card and its clip. */
  scene?: string;
}

/** Validates now (so a missing build is an error, not a failed job), then renders in the background. Returns the job id. */
export async function startExport(a: ExportArgs): Promise<string> {
  const p = videoPaths(a.cwd, a.name);
  const props = await readJson<StudioProps>(p.propsFile);
  if (!props?.scenes.length) throw new Error(`nothing to export for "${a.name}": run video_build first`);
  if (!existsSync(join(p.publicDir, props.video))) throw new Error(`the capture is missing from ${p.publicDir}: run video_build`);
  const quality = a.quality ?? "draft";
  const range = exportRange(props, a);
  // A fragment never takes the full export's name, so video_publish cannot upload one by mistake.
  const partial = !!(a.scene || a.frames);
  const out = partial ? p.outFile(quality).replace(/\.mp4$/, "-part.mp4") : p.outFile(quality);
  // a failed render must not truncate the last good export, and another thread's export of this video must not share the file
  const tmp = out.replace(/\.mp4$/, `.${process.pid}-${Date.now().toString(36)}.tmp.mp4`);
  return startJob(
    p,
    "export",
    new Date().toISOString(),
    async (progress) => {
      await mkdir(p.outDir, { recursive: true });
      try {
        await spawnRender({ studioDir: p.studioDir, mode: "media", propsFile: p.propsFile, out: tmp, frames: range, quality }, (f) => progress("export", f));
        await rename(tmp, out);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const bytes = (await stat(out)).size;
      return {
        path: out,
        quality,
        partial,
        frames: range,
        durationMs: Math.round(((range.to - range.from + 1) / props.fps) * 1000),
        bytes,
        ...(bytes > MAX_FILE_BYTES ? { warning: `${(bytes / 1048576).toFixed(1)} MB is over the ${MAX_FILE_BYTES / 1048576} MB Files library cap: export quality "draft" or shorten the video` } : {}),
      };
    },
    quality,
  );
}

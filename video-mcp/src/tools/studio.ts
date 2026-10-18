import { existsSync } from "node:fs";
import { readStudioState, startStudio, stopStudio, studioStatus } from "../remotion.js";
import { videoPaths } from "../storyboard.js";
import type { StudioInfo } from "../types.js";

export type StudioAction = "start" | "stop" | "status";

/** Studio is a detached child per video; this is the one place the MCP tool touches it. */
export async function studioTool(a: { cwd: string; name: string; action: StudioAction }): Promise<StudioInfo & { stopped?: boolean; note?: string }> {
  const p = videoPaths(a.cwd, a.name);
  if (a.action === "stop") return { ...(await stopStudio(p)), running: false };
  if (a.action === "status") {
    const s = await studioStatus(p);
    const stale = !s.running && !!(await readStudioState(p));
    return { running: s.running, url: s.url, port: s.port, ...(stale ? { note: "Studio died; video_studio start restarts it" } : {}) };
  }
  if (!existsSync(p.studioDir)) throw new Error(`no studio for "${a.name}": run video_init (or video_build) first`);
  const s = await startStudio(p);
  return { running: true, url: s.url, port: s.port };
}

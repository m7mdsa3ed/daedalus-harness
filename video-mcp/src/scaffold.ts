import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GITIGNORE } from "./storyboard.js";
import { type StudioProps, ZOOM_EASE_MS, msToFrame } from "./studio-props.js";

// src/ and dist/ are both one level below the package root.
export const TEMPLATE_DIR = fileURLToPath(new URL("../templates/studio", import.meta.url));

const exists = (p: string) => stat(p).then(() => true, () => false);

export const placeholderProps = (): StudioProps => ({ width: 1280, height: 720, fps: 30, durationMs: 1000, video: "video.mp4", easeMs: ZOOM_EASE_MS, scenes: [] });

/**
 * Makes <videoDir>/studio from the template, once: files that exist are never overwritten, because the person
 * may be editing the composition. reset re-copies src/ and scripts/ (the harness's side of the contract with render.mjs).
 * Also tops up .gitignore with the lines a studio needs. props.json and public/ are generated, not copied.
 */
export async function scaffoldStudio(videoDir: string, o: { reset?: boolean } = {}): Promise<void> {
  if (!(await exists(TEMPLATE_DIR))) throw new Error(`studio template not found at ${TEMPLATE_DIR}`);
  const studio = join(videoDir, "studio");
  const skip = (src: string) => !/^(node_modules|public|props\.json)(\/|$)/.test(relative(TEMPLATE_DIR, src).split("\\").join("/"));
  await cp(TEMPLATE_DIR, studio, { recursive: true, force: false, errorOnExist: false, filter: skip });
  if (o.reset) for (const d of ["src", "scripts"]) await cp(join(TEMPLATE_DIR, d), join(studio, d), { recursive: true, force: true, filter: skip });
  await mkdir(join(studio, "public"), { recursive: true });
  if (!(await exists(join(studio, "props.json")))) await writeFile(join(studio, "props.json"), JSON.stringify(placeholderProps(), null, 2) + "\n");

  const gi = join(videoDir, ".gitignore");
  const cur = await readFile(gi, "utf8").catch(() => "");
  const missing = GITIGNORE.split("\n").filter((l) => l && !cur.split("\n").includes(l));
  if (missing.length) await writeFile(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + missing.join("\n") + "\n");
}

/** Total frames of the composition, as its calculateMetadata counts them. */
export const totalFrames = (props: Pick<StudioProps, "durationMs" | "fps">): number => Math.max(1, msToFrame(props.durationMs, props.fps));

/**
 * The inclusive frame range an export covers: one step (its card and its clip), an explicit "a-b", or everything.
 * Throws a sentence the agent can act on.
 */
export function exportRange(props: StudioProps, o: { scene?: string; frames?: string }): { from: number; to: number } {
  const last = totalFrames(props) - 1;
  if (o.scene && o.frames) throw new Error("pass either scene or frames, not both");
  if (o.scene) {
    const mine = props.scenes.filter((s) => s.stepId === o.scene);
    if (!mine.length) throw new Error(`no scene for step "${o.scene}" in props.json (steps: ${[...new Set(props.scenes.map((s) => s.stepId).filter(Boolean))].join(", ") || "none, run video_build"})`);
    const from = Math.min(...mine.map((s) => msToFrame(s.fromMs, props.fps)));
    const to = Math.max(...mine.map((s) => msToFrame(s.fromMs + s.durMs, props.fps))) - 1;
    return { from: Math.min(from, last), to: Math.min(Math.max(to, from), last) };
  }
  if (o.frames) {
    const m = /^(\d+)-(\d+)$/.exec(o.frames.trim());
    if (!m) throw new Error(`frames must look like "0-120", got "${o.frames}"`);
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (from > to || to > last) throw new Error(`frames ${o.frames} are outside the composition (0-${last})`);
    return { from, to };
  }
  return { from: 0, to: last };
}

/** One still per scene: the middle frame of each, so a card shows its text settled and a clip shows its action. */
export function sceneStills(props: StudioProps): { index: number; stepId?: string; type: "card" | "clip"; frame: number }[] {
  const last = totalFrames(props) - 1;
  return props.scenes.map((s, index) => ({ index, stepId: s.stepId, type: s.type, frame: Math.min(last, msToFrame(s.fromMs + s.durMs / 2, props.fps)) }));
}

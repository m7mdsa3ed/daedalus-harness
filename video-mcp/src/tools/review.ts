import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson } from "../cache.js";
import { run } from "../exec.js";
import { spawnRender } from "../remotion.js";
import { sceneStills } from "../scaffold.js";
import { loadStoryboard, videoPaths } from "../storyboard.js";
import type { StudioProps } from "../studio-props.js";
import type { BuildInfo, ReviewArgs, ReviewReport, ReviewResult, ReviewScene, ReviewStep } from "../types.js";

// What lands in out/report.json: the typed ReviewReport plus the extra fields the agent reads.
export interface FullStep extends ReviewStep {
  index: number;
  audioLongerThanStep: boolean;
  ttsCache: "hit" | "miss" | "none";
}
export interface FullReport extends ReviewReport {
  steps: FullStep[];
  firstFrameLuma: number | null;
  firstFrameBlank: boolean;
}

const CELL_W = 480;
const LABEL_H = 100; // five 14px lines
const COLS = 4; // 4 x 480 = 1920px, readable as one image
const LINE_CHARS = 54;
const NARRATION_LINES = 3;

/** Word-wrap to at most `lines` lines, ellipsis when cut. */
export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = word.length > width ? word.slice(0, width - 1) + "…" : word;
    if (cur && cur.length + 1 + w.length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = out[lines - 1].slice(0, width - 1).replace(/\s+$/, "") + "…";
  }
  return out;
}

const secs = (ms: number) => (ms / 1000).toFixed(1);

/** Mean luma and range of a still. ponytail: "blank" = a flat frame (range < 6), a white splash counts. */
async function firstFrame(path: string): Promise<{ luma: number | null; blank: boolean }> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"]);
  const get = (k: string) => Number(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`).exec(stdout)?.[1]);
  const [avg, lo, hi] = [get("YAVG"), get("YMIN"), get("YMAX")];
  if (!Number.isFinite(avg)) return { luma: null, blank: false };
  return { luma: Math.round(avg * 10) / 10, blank: hi - lo < 6 };
}

export async function reviewVideo(args: ReviewArgs): Promise<ReviewResult> {
  const p = videoPaths(args.cwd, args.name);
  const build = await readJson<BuildInfo>(p.buildFile);
  const props = await readJson<StudioProps>(p.propsFile);
  if (!build || !props?.scenes.length) throw new Error(`no build for "${args.name}" yet: run video_build first`);
  const say = new Map((await loadStoryboard(p).catch(() => undefined))?.steps.map((s) => [s.id, s.say]));

  const all = build.perStep;
  const want = args.stepIds?.length ? new Set(args.stepIds) : undefined;
  if (want) {
    const unknown = [...want].filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown step id(s): ${unknown.join(", ")}. Built steps: ${all.map((s) => s.id).join(", ")}`);
  }

  const warnings: string[] = [...build.warnings];
  const steps: FullStep[] = [];
  all.forEach((s, i) => {
    if (want && !want.has(s.id)) return; // indexed by real position, filtered after
    const stepMs = s.endMs - s.startMs;
    const longer = s.audioMs > stepMs;
    const w = [...s.warnings];
    if (longer) w.push(`narration (${secs(s.audioMs)}s) is longer than the step (${secs(stepMs)}s)`);
    steps.push({ index: i + 1, id: s.id, say: say.get(s.id), audioMs: s.audioMs, stepMs, startMs: s.startMs, endMs: s.endMs, audioLongerThanStep: longer, ttsCache: s.tts, warnings: w });
  });
  for (const s of steps) for (const w of s.warnings) warnings.push(`${s.id}: ${w}`);

  // One still per scene (the intro only on a full sheet), all from one Remotion bundle.
  const picked = sceneStills(props).filter((c) => !want || (c.stepId && want.has(c.stepId)));
  const scenes: ReviewScene[] = picked.map((c) => {
    const sc = props.scenes[c.index];
    return { index: c.index, type: c.type, kind: sc.kind, stepId: c.stepId, fromMs: sc.fromMs, durMs: sc.durMs, frame: c.frame };
  });
  await rm(p.stillsDir, { recursive: true, force: true });
  await mkdir(p.stillsDir, { recursive: true });
  await spawnRender({ studioDir: p.studioDir, mode: "still", propsFile: p.propsFile, out: p.stillsDir, frame: [...new Set(scenes.map((c) => c.frame))] });

  // The still is a PNG at the composition's size; the label bar goes under it.
  const cellH = Math.round((CELL_W * props.height) / props.width / 2) * 2;
  const tmp = await mkdtemp(join(tmpdir(), "video-review-"));
  let ff: { luma: number | null; blank: boolean } = { luma: null, blank: false };
  try {
    let n = 0;
    for (const c of scenes) {
      const still = join(p.stillsDir, `${c.frame}.png`);
      const step = steps.find((s) => s.id === c.stepId);
      const sc = props.scenes[c.index];
      // Narration is user content: it goes in text FILES so no filter escaping can be wrong. One
      // drawtext per line, because ffmpeg 8 draws the newline of a multi-line textfile as a tofu box.
      const span = `${secs(c.fromMs)}-${secs(c.fromMs + c.durMs)}s`;
      const head = c.type === "clip" ? `${step?.index ?? "?"}. ${c.stepId}  ${span}` : c.kind === "intro" ? `intro card  ${span}` : `chapter card (${c.stepId})  ${span}`;
      const lines = [head, ...wrap(c.type === "clip" ? (step?.say ?? "(no narration)") : (sc.text ?? ""), LINE_CHARS, NARRATION_LINES)];
      const draws: string[] = [];
      for (const [li, line] of lines.entries()) {
        const textFile = join(tmp, `label-${n}-${li}.txt`);
        await writeFile(textFile, line, "utf8");
        draws.push(`drawtext=textfile=${textFile}:expansion=none:fontcolor=white:fontsize=14:x=6:y=${cellH + 6 + li * 18}`);
      }
      const vf = [`scale=${CELL_W}:${cellH}`, `pad=${CELL_W}:${cellH + LABEL_H}:0:0:color=black`, ...draws].join(",");
      try {
        await run("ffmpeg", ["-v", "error", "-y", "-i", still, "-frames:v", "1", "-vf", vf, join(tmp, `cell-${String(n + 1).padStart(3, "0")}.png`)]);
        if (ff.luma === null && c.type === "clip") ff = await firstFrame(still);
        n++;
      } catch (e) {
        warnings.push(`${c.stepId ?? "intro"}: no frame for the contact sheet: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    }
    if (n === 0) throw new Error("could not tile any still");
    const cols = Math.min(n, COLS);
    await run("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", join(tmp, "cell-%03d.png"), "-vf", `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=0x202020`, "-frames:v", "1", p.contactSheet]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (ff.blank) warnings.push("the first clip frame is blank (flat colour): the page may not have loaded when recording started");

  const report: FullReport = { name: args.name, durationMs: props.durationMs, scenes, steps, firstFrameLuma: ff.luma, firstFrameBlank: ff.blank, warnings };
  await writeFile(p.reportFile, JSON.stringify(report, null, 2) + "\n");
  return { contactSheetPath: p.contactSheet, reportPath: p.reportFile, report };
}

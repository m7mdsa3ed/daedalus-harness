import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

// ---- schema ---------------------------------------------------------------

const selectors = z.array(z.array(z.string()));

// Chrome DevTools Recorder export shape. Loose: real exports carry target, frame,
// timeout, assertedEvents... and we execute what we know and ignore the rest.
const recorderAction = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("navigate"), url: z.string() }),
  z.looseObject({ type: z.literal("click"), selectors, offsetX: z.number().optional(), offsetY: z.number().optional() }),
  z.looseObject({ type: z.literal("doubleClick"), selectors, offsetX: z.number().optional(), offsetY: z.number().optional() }),
  z.looseObject({ type: z.literal("hover"), selectors }),
  z.looseObject({ type: z.literal("change"), selectors, value: z.string() }),
  z.looseObject({ type: z.literal("keyDown"), key: z.string() }),
  z.looseObject({ type: z.literal("keyUp"), key: z.string() }),
  z.looseObject({ type: z.literal("waitForElement"), selectors }),
  z.looseObject({ type: z.literal("scroll"), x: z.number().optional(), y: z.number().optional(), selectors: selectors.optional() }),
  z.looseObject({ type: z.literal("setViewport"), width: z.number(), height: z.number() }),
  z.looseObject({ type: z.literal("waitForExpression"), expression: z.string() }),
]);

// Playwright-style. Strict so an agent's typo ("selectr") is an error, not a no-op.
const playwrightAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), url: z.string() }),
  z.strictObject({ action: z.literal("click"), selector: z.string() }),
  z.strictObject({ action: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.strictObject({ action: z.literal("type"), selector: z.string(), value: z.string() }),
  z.strictObject({ action: z.literal("press"), key: z.string(), selector: z.string().optional() }),
  z.strictObject({ action: z.literal("hover"), selector: z.string() }),
  z.strictObject({ action: z.literal("wait"), ms: z.number().min(0) }),
  z.strictObject({ action: z.literal("scroll"), selector: z.string().optional(), y: z.number().optional() }),
]);

const ACTION_HELP =
  'invalid action: use a Recorder step {"type": navigate|click|doubleClick|hover|change|keyDown|keyUp|waitForElement|scroll|setViewport|waitForExpression, ...} or a Playwright action {"action": goto|click|fill|type|press|hover|wait|scroll, ...} (check required fields and spelling)';

export const ActionSchema = z.union([recorderAction, playwrightAction], { error: ACTION_HELP });

const ZoomSchema = z.union([
  z.literal(true),
  z.strictObject({ selector: z.string().optional(), scale: z.number().min(1).max(4).optional() }),
]);

const OverlaySchema = z.strictObject({
  text: z.string().min(1),
  position: z.enum(["top", "bottom", "center"]).optional(),
});

export const StepSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]+$/, "step id must match /^[a-z0-9_-]+$/"),
  say: z.string().optional(),
  /** A title card shown before this step. */
  chapter: z.string().optional(),
  do: z.union([ActionSchema, z.array(ActionSchema)], { error: ACTION_HELP }).optional(),
  hold: z.number().min(0).optional(),
  zoom: ZoomSchema.optional(),
  voice: z.string().optional(),
  overlay: OverlaySchema.optional(),
  at: z.number().min(0).optional(),
  locked: z.boolean().optional(),
});

export const StoryboardSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string(),
    baseUrl: z.string().optional(),
    viewport: z.strictObject({ width: z.number().int().min(320), height: z.number().int().min(240) }).default({ width: 1280, height: 720 }),
    // ids are free strings checked against the registry at build time, so a new
    // provider is one registry line and never a schema edit.
    providers: z
      .strictObject({ capture: z.string().optional(), tts: z.string().optional() })
      .optional(),
    voice: z.string().optional(),
    file: z.string().optional(),
    steps: z.array(StepSchema),
  })
  .superRefine((sb, ctx) => {
    const seen = new Set<string>();
    sb.steps.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${s.id}"` });
      seen.add(s.id);
    });
  });

export type Action = z.infer<typeof ActionSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;

export function actionsOf(step: Step): Action[] {
  return step.do === undefined ? [] : Array.isArray(step.do) ? step.do : [step.do];
}

// ---- paths ----------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid video name "${name}": use lowercase letters, digits and hyphens (max 64), starting with a letter or digit`);
  return name;
}

/** Resolve rel under base and refuse to leave it. ponytail: lexical check, symlinks are not resolved. */
export function inside(base: string, ...rel: string[]): string {
  const root = resolve(base);
  const p = resolve(root, ...rel);
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`path escapes the video folder: ${rel.join("/")}`);
  return p;
}

export interface VideoPaths {
  name: string;
  dir: string;
  storyboard: string;
  gitignore: string;
  cacheDir: string;
  ttsDir: string;
  captureDir: string;
  jobsDir: string;
  lockedFile: string;
  buildFile: string;
  timelineFile: string;
  /** The Remotion project (scaffolded once, then the person's to edit). */
  studioDir: string;
  /** Generated each build: the assets the composition reads, and its one input. */
  publicDir: string;
  propsFile: string;
  /** pid, port, url of the running Studio. */
  studioState: string;
  outDir: string;
  stillsDir: string;
  contactSheet: string;
  reportFile: string;
  outFile(quality: "draft" | "final"): string;
}

/** Tracked: storyboard.json and studio/ (minus what a build generates). */
export const GITIGNORE = "node_modules/\n.cache/\nout/\nstudio/public/\nstudio/props.json\n";

export function videosRoot(cwd: string): string {
  return join(resolve(cwd), ".daedalus", "videos");
}

export function videoPaths(cwd: string, name: string): VideoPaths {
  validateName(name);
  const dir = inside(videosRoot(cwd), name);
  const cache = join(dir, ".cache");
  const out = join(dir, "out");
  return {
    name,
    dir,
    storyboard: join(dir, "storyboard.json"),
    gitignore: join(dir, ".gitignore"),
    cacheDir: cache,
    ttsDir: join(cache, "tts"),
    captureDir: join(cache, "capture"),
    jobsDir: join(cache, "jobs"),
    lockedFile: join(cache, "locked.json"),
    buildFile: join(cache, "build.json"),
    timelineFile: join(cache, "timeline.json"),
    studioDir: join(dir, "studio"),
    publicDir: join(dir, "studio", "public"),
    propsFile: join(dir, "studio", "props.json"),
    studioState: join(cache, "studio.json"),
    outDir: out,
    stillsDir: join(out, "stills"),
    contactSheet: join(out, "contact-sheet.png"),
    reportFile: join(out, "report.json"),
    outFile: (q) => join(out, `${name}-${q}.mp4`),
  };
}

export async function ensureDirs(p: VideoPaths): Promise<void> {
  for (const d of [p.ttsDir, p.captureDir, p.jobsDir, p.outDir]) await mkdir(d, { recursive: true });
}

// ---- load / save ----------------------------------------------------------

export function parseStoryboard(raw: unknown): Storyboard {
  const r = StoryboardSchema.safeParse(raw);
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  const gone = /providers: .*"render"/.test(msg) ? ' (providers.render was removed: rendering is the studio composition now; delete the key)' : "";
  throw new Error(`invalid storyboard: ${msg}${gone}`);
}

export async function loadStoryboard(p: VideoPaths): Promise<Storyboard> {
  let text: string;
  try {
    text = await readFile(p.storyboard, "utf8");
  } catch {
    throw new Error(`no storyboard for "${p.name}" (expected ${p.storyboard}); run video_init first`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`storyboard.json is not valid JSON: ${(e as Error).message}`);
  }
  return parseStoryboard(json);
}

export async function saveStoryboard(p: VideoPaths, sb: Storyboard): Promise<void> {
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.storyboard, JSON.stringify(sb, null, 2) + "\n");
}

// ---- hashing and locks ----------------------------------------------------

export function sha256(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Whole step minus the flag itself, so locking or unlocking never counts as an edit. */
export function stepHash(step: Step): string {
  const { locked: _locked, ...rest } = step;
  return sha256(rest);
}

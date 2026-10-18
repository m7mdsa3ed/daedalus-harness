import { existsSync } from "node:fs";
import { open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readJson } from "./cache.js";
import { chosenIds, harnessUrl, readiness } from "./config.js";
import { redact } from "./exec.js";
import { getJob, startJob } from "./jobs.js";
import { build } from "./pipeline.js";
import { REGISTRY } from "./providers/registry.js";
import { missingRemotionPackages, notInstalledMessage, remotionInfo, studioStatus } from "./remotion.js";
import { importRecorder } from "./recorder-import.js";
import { scaffoldStudio } from "./scaffold.js";
import { GITIGNORE, type Storyboard, ensureDirs, loadStoryboard, parseStoryboard, saveStoryboard, videoPaths, videosRoot } from "./storyboard.js";
import { startExport } from "./tools/export.js";
import { publishVideo } from "./tools/publish.js";
import { reviewVideo } from "./tools/review.js";
import { studioTool } from "./tools/studio.js";
import type { ProviderKind } from "./types.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (v: unknown): { content: Content[] } => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const failure = (e: unknown) => ({ isError: true as const, content: [{ type: "text" as const, text: redact(e instanceof Error ? e.message : String(e)) }] });

/** Every handler's errors become a tool error, never a protocol error, and never carry a key. */
function guard<A>(fn: (a: A) => Promise<{ content: Content[] }>) {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return failure(e);
    }
  };
}

/** Remotion is looked for where the install hint sends people (a studio/) as well as in parent folders: the first video whose studio resolves it, else the videos root. */
async function remotionStatus(cwd: string) {
  const root = videosRoot(cwd);
  const dirs = (await readdir(root).catch(() => [] as string[])).map((n) => join(root, n, "studio"));
  const infos = dirs.filter((d) => existsSync(join(d, "package.json"))).map(remotionInfo);
  return infos.find((i) => i.installed) ?? infos[0] ?? remotionInfo(root);
}

const NAME = z.string().describe("video name: lowercase letters, digits, hyphens");
const QUALITY = z.enum(["draft", "final"]);
const IMAGE_INLINE_MAX = 2 * 1024 * 1024;
const RECORDER_MAX_BYTES = 5 * 1024 * 1024;

/** Read a file that must stay inside `root` (symlinks resolved) and under RECORDER_MAX_BYTES, without ever holding more than the cap. */
export async function readInsideRoot(root: string, path: string): Promise<string> {
  const real = await realpath(resolve(root, path)).catch(() => {
    throw new Error(`cannot read "${path}"`);
  });
  const top = await realpath(root);
  if (real !== top && !real.startsWith(top + sep)) throw new Error(`"${path}" is outside the project`);
  if (!(await stat(real)).isFile()) throw new Error(`"${path}" is not a regular file`);
  const fh = await open(real, "r");
  try {
    const buf = Buffer.alloc(RECORDER_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > RECORDER_MAX_BYTES) throw new Error(`"${path}" is larger than ${RECORDER_MAX_BYTES / 1048576} MB`);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "daedalus-video-mcp", version: "0.1.0" });

  // The project is the client's first root when it offers one, else where we were started.
  let cwd: string | undefined;
  async function projectCwd(): Promise<string> {
    if (cwd) return cwd;
    try {
      if (server.server.getClientCapabilities()?.roots) {
        const uri = (await server.server.listRoots()).roots[0]?.uri;
        if (uri?.startsWith("file://")) return (cwd = fileURLToPath(uri));
      }
    } catch {}
    return (cwd = process.cwd());
  }

  server.registerTool(
    "video_init",
    {
      description:
        "Create .daedalus/videos/<name>/: a starter storyboard.json and the Remotion project in studio/ (scaffolded once, never overwritten). The storyboard drives capture and narration: edit it with ordinary file tools, then video_build. Relative urls in actions resolve against baseUrl. Fails after scaffolding, with the install line, if Remotion is not installed.",
      inputSchema: { name: NAME, title: z.string().optional(), baseUrl: z.string().optional() },
    },
    guard(async ({ name, title, baseUrl }) => {
      const p = videoPaths(await projectCwd(), name);
      const existing = await stat(p.storyboard).then(() => true, () => false);
      await ensureDirs(p);
      if (!existing) {
        const sb: Storyboard = parseStoryboard({
          version: 1,
          title: title ?? name,
          ...(baseUrl ? { baseUrl } : {}),
          steps: [{ id: "intro", say: `Welcome to ${title ?? name}.`, ...(baseUrl ? { do: { action: "goto", url: "/" } } : {}) }],
        });
        await saveStoryboard(p, sb);
      }
      await scaffoldStudio(p.dir); // also writes .gitignore; an existing studio/ is left as the person edited it
      const missing = missingRemotionPackages(p.studioDir);
      if (missing.length) throw new Error(`${existing ? "Scaffolded" : "Created"} ${p.dir}, but ${notInstalledMessage(p.studioDir, missing)}`);
      return text({ created: !existing, storyboard: p.storyboard, studio: p.studioDir, ...(existing ? { note: "storyboard already exists; edit it directly" } : {}) });
    }),
  );

  server.registerTool(
    "video_list",
    { description: "List the videos in this project with their title, step count, whether Studio is running (and its url) and exported mp4s.", inputSchema: {} },
    guard(async () => {
      const root = videosRoot(await projectCwd());
      const out: unknown[] = [];
      for (const n of await readdir(root).catch(() => [] as string[])) {
        let p;
        try {
          p = videoPaths(await projectCwd(), n);
        } catch {
          continue;
        }
        const sb = await readJson<{ title?: string; steps?: unknown[] }>(p.storyboard);
        if (!sb) continue;
        const exports: Record<string, { bytes: number; modifiedIso: string }> = {};
        for (const f of await readdir(p.outDir).catch(() => [] as string[])) {
          const s = f.endsWith(".mp4") && !f.endsWith(".tmp.mp4") ? await stat(join(p.outDir, f)).catch(() => undefined) : undefined;
          if (s) exports[f] = { bytes: s.size, modifiedIso: s.mtime.toISOString() };
        }
        const { running, url } = await studioStatus(p);
        out.push({ name: n, title: sb.title, steps: sb.steps?.length ?? 0, studio: running ? { running, url } : { running }, exports });
      }
      return text(out);
    }),
  );

  server.registerTool(
    "video_import_recorder",
    {
      description:
        "Turn a Chrome DevTools Recorder JSON export into a storyboard (one step per recorder step, empty narration). Pass the JSON inline or a file path relative to the project.",
      inputSchema: {
        name: NAME,
        recorderJson: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("the export, as a JSON string or object"),
        path: z.string().optional().describe("path to the export file"),
        overwrite: z.boolean().optional().describe("replace an existing storyboard"),
      },
    },
    guard(async ({ name, recorderJson, path, overwrite }) => {
      const root = await projectCwd();
      const p = videoPaths(root, name);
      if (recorderJson === undefined && !path) throw new Error("give recorderJson or path");
      const rawText = recorderJson === undefined ? await readInsideRoot(root, path!) : typeof recorderJson === "string" ? recorderJson : JSON.stringify(recorderJson);
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch (e) {
        // The engine's message can quote the file; say only where it broke.
        const at = /position (\d+)/.exec((e as Error).message)?.[1];
        throw new Error(`recorder export is not valid JSON${at ? ` at position ${at}` : ""}`);
      }
      if (!overwrite && (await stat(p.storyboard).then(() => true, () => false))) throw new Error(`"${name}" already has a storyboard; pass overwrite:true to replace it`);
      const sb = importRecorder(raw, name);
      await ensureDirs(p);
      await writeFile(p.gitignore, GITIGNORE);
      await saveStoryboard(p, sb);
      return text({ storyboard: p.storyboard, steps: sb.steps.length, note: "add \"say\" narration to the steps, then video_build" });
    }),
  );

  server.registerTool(
    "video_build",
    {
      description:
        "Capture the flow and narrate it, in the background: returns {jobId} at once, poll video_job. Writes the assets and props into studio/ and starts Remotion Studio, where the video plays live; cards, captions, zoom and sound are the composition's, so edit studio/src there without rebuilding. props.json and public/ are regenerated by every build and hand edits to them are lost; put lasting changes in studio/src or the storyboard. Renders no mp4 (video_export does). Unchanged narration and captures are reused from cache. force re-runs a cache; resetStudio restores studio/src and studio/scripts from the template, discarding your edits to them.",
      inputSchema: {
        name: NAME,
        force: z.array(z.enum(["tts", "capture"])).optional().describe("ignore these caches"),
        resetStudio: z.boolean().optional().describe("re-copy studio/src and studio/scripts from the template"),
      },
    },
    guard(async ({ name, force, resetStudio }) => {
      const root = await projectCwd();
      const p = videoPaths(root, name);
      await loadStoryboard(p); // fail on a bad storyboard now, not inside the job
      const startedAtIso = new Date().toISOString();
      const jobId = startJob(p, "build", startedAtIso, (onProgress) => build({ cwd: root, name, force, resetStudio, startedAtIso, onProgress }));
      return text({ jobId });
    }),
  );

  server.registerTool(
    "video_studio",
    {
      description:
        "Start, stop or check the Remotion Studio of a video (live preview with hot reload, a detached process on a port in 3100-3199, loopback only unless VIDEO_STUDIO_HOST widens it: Studio can write files and render). Returns {running, url, port}. video_build starts it already.",
      inputSchema: { name: NAME, action: z.enum(["start", "stop", "status"]) },
    },
    guard(async ({ name, action }) => text(await studioTool({ cwd: await projectCwd(), name, action }))),
  );

  server.registerTool(
    "video_export",
    {
      description:
        "Render the composition to out/<name>-<quality>.mp4 in the background: returns {jobId}, poll video_job. draft is small and fast, final is full quality. scene (a step id: its card and clip) or frames (\"a-b\", inclusive) render a fragment to out/<name>-<quality>-part.mp4 instead. Needs a video_build first.",
      inputSchema: {
        name: NAME,
        quality: QUALITY.optional().describe("default draft"),
        scene: z.string().optional().describe("a step id"),
        frames: z.string().optional().describe("composition frame range, e.g. \"0-120\""),
      },
    },
    guard(async ({ name, quality, scene, frames }) => text({ jobId: await startExport({ cwd: await projectCwd(), name, quality, scene, frames }) })),
  );

  server.registerTool(
    "video_job",
    { description: "Status of a video_build or video_export job: running (with stage and progress), done (with the build report or the export summary) or failed (with the error).", inputSchema: { jobId: z.string() } },
    guard(async ({ jobId }) => {
      const j = await getJob(await projectCwd(), jobId);
      if (!j) throw new Error(`unknown job "${jobId}"`);
      return text(j);
    }),
  );

  server.registerTool(
    "video_review",
    {
      description:
        "After a build, no mp4 needed: renders one still per scene (cards included) and writes out/contact-sheet.png (id, timing and narration on each) and out/report.json (scene timings on the composition's clock, audio vs step length, warnings); returns the report and the sheet. Takes about 30 s. Look at the sheet, then edit the storyboard or the composition.",
      inputSchema: { name: NAME, stepIds: z.array(z.string()).optional() },
    },
    guard(async ({ name, stepIds }) => {
      const r = await reviewVideo({ cwd: await projectCwd(), name, stepIds });
      const content: Content[] = [{ type: "text", text: JSON.stringify({ contactSheet: r.contactSheetPath, reportFile: r.reportPath, report: r.report }, null, 2) }];
      // The sheet is for the agent to look at; inline it unless it is huge.
      const png = await readFile(r.contactSheetPath).catch(() => undefined);
      if (png && png.length <= IMAGE_INLINE_MAX) content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      return { content };
    }),
  );

  server.registerTool(
    "video_providers",
    { description: "Which capture and tts providers exist, their capabilities, and which are configured right now; and whether Remotion (Studio and export) is installed. Never shows keys.", inputSchema: {} },
    guard(async () => {
      const chosen = chosenIds();
      const out: Record<string, unknown[]> = {};
      for (const kind of ["capture", "tts"] as ProviderKind[]) {
        out[kind] = [];
        for (const [id, prov] of Object.entries(REGISTRY[kind])) {
          const r = await readiness(kind, id);
          out[kind].push({ id, capabilities: prov.capabilities, configured: r.configured, default: chosen[kind] === id, ...(r.configured ? {} : { hint: r.hint }) });
        }
      }
      return text({ ...out, remotion: await remotionStatus(await projectCwd()), harness: harnessUrl() ? "connected" : "not connected (video_publish unavailable)" });
    }),
  );

  server.registerTool(
    "video_publish",
    {
      description: "Upload out/<name>-<quality>.mp4 (from video_export) to the harness Files library under Videos/<folder or name>. Needs the harness; the Files library caps files at 25 MB.",
      inputSchema: { name: NAME, quality: QUALITY.optional().describe("default draft"), folder: z.string().optional() },
    },
    guard(async ({ name, quality, folder }) => text(await publishVideo({ cwd: await projectCwd(), name, quality: quality ?? "draft", folder }))),
  );

  return server;
}


import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, desc, and, sql } from "drizzle-orm";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";
import { DATA_DIR } from "../config.js";
import { db, sessions, sessionVideos, sessionVideoRenders } from "../db/index.js";
import { HttpError } from "../http-error.js";
import { TtsSynthesisSchema, VideoDocumentSchema, type VideoDocument } from "./schema.js";
import { synthesizeSpeech } from "./providers.js";

const renderQueue: string[] = [];
let draining = false;
const outputPath = (id: string) => join(DATA_DIR, "videos", "renders", `${id}.mp4`);

interface RendererProvider {
  id: string;
  render(input: {
    entryPoint: string;
    publicDir: string;
    document: VideoDocument;
    outputPath: string;
    onProgress: (progress: number) => void;
  }): Promise<void>;
}

const remotionRenderer: RendererProvider = {
  id: "remotion",
  async render({ entryPoint, publicDir, document, outputPath, onProgress }) {
    const serveUrl = await bundle({ entryPoint, publicDir, onProgress: () => undefined });
    const [composition] = await getCompositions(serveUrl, { inputProps: { document }, logLevel: "error" });
    if (!composition) throw new Error("The video composition could not be loaded");
    await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: outputPath, inputProps: { document }, concurrency: 2,
      onProgress: ({ progress }) => onProgress(Math.min(99, Math.round(progress * 100))),
    });
  },
};

const renderers = new Map<string, RendererProvider>([[remotionRenderer.id, remotionRenderer]]);
const DEFAULT_RENDERER = "remotion";

async function requireSession(sessionId: string) {
  const row = (await db.select({ id: sessions.id, deletedAt: sessions.deletedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1))[0];
  if (!row || row.deletedAt !== null) throw new HttpError("no such thread", 404);
}

export async function readVideo(sessionId: string) {
  await requireSession(sessionId);
  const video = (await db.select().from(sessionVideos).where(eq(sessionVideos.sessionId, sessionId)).limit(1))[0];
  const renders = await db.select().from(sessionVideoRenders).where(eq(sessionVideoRenders.sessionId, sessionId)).orderBy(desc(sessionVideoRenders.createdAt)).limit(30);
  return {
    document: video?.document ?? null,
    revision: video?.revision ?? 0,
    renders: renders.map(({ outputPath: _outputPath, document: _document, ...render }) => render),
  };
}

export async function saveVideo(sessionId: string, input: unknown) {
  await requireSession(sessionId);
  const document = VideoDocumentSchema.parse(input);
  const now = Date.now();
  const [row] = await db.insert(sessionVideos).values({ sessionId, document, revision: 1, updatedAt: now })
    .onConflictDoUpdate({ target: sessionVideos.sessionId, set: { document, revision: sql`${sessionVideos.revision} + 1`, updatedAt: now } }).returning();
  return row;
}

export async function generateVideoSpeech(sessionId: string, body: unknown) {
  await requireSession(sessionId);
  const { text, sceneId } = TtsSynthesisSchema.parse(body);
  const current = await readVideo(sessionId);
  const base = current.document ? VideoDocumentSchema.parse(current.document) : VideoDocumentSchema.parse({});
  if (!base.scenes.some((scene) => scene.id === sceneId)) throw new HttpError("no such scene", 404);
  const { name } = await synthesizeSpeech({ provider: "elevenlabs", text, sessionId });
  const document = VideoDocumentSchema.parse({
    ...base,
    scenes: base.scenes.map((scene) => scene.id === sceneId ? { ...scene, audioFile: name } : scene),
  });
  await saveVideo(sessionId, document);
  return { sceneId, audioFile: name };
}

async function renderOne(renderId: string) {
  const [job] = await db.select().from(sessionVideoRenders).where(eq(sessionVideoRenders.id, renderId)).limit(1);
  if (!job || job.status !== "queued") return;
  const now = Date.now();
  await db.update(sessionVideoRenders).set({ status: "rendering", progress: 1, updatedAt: now }).where(eq(sessionVideoRenders.id, renderId));
  try {
    const document = VideoDocumentSchema.parse(job.document);
    const tempDir = join(DATA_DIR, "videos", "bundles", job.id);
    const publicDir = join(tempDir, "public");
    await mkdir(publicDir, { recursive: true });
    for (const scene of document.scenes) {
      if (!scene.audioFile) continue;
      const safeName = scene.audioFile.replace(/[^a-zA-Z0-9._-]/g, "");
      if (safeName !== scene.audioFile) throw new Error("Invalid audio asset name");
      await copyFile(join(DATA_DIR, "videos", "audio", job.sessionId, safeName), join(publicDir, safeName));
    }
    const directory = dirname(new URL(import.meta.url).pathname);
    const entry = [join(directory, "renderer.tsx"), join(directory, "renderer.js")].find(existsSync);
    if (!entry) throw new Error("Remotion composition source was not found");
    const renderer = renderers.get(DEFAULT_RENDERER);
    if (!renderer) throw new Error(`Renderer "${DEFAULT_RENDERER}" is not available`);
    const path = outputPath(job.id);
    await mkdir(dirname(path), { recursive: true });
    let lastProgressAt = 0;
    await renderer.render({
      entryPoint: entry,
      publicDir,
      document,
      outputPath: path,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgressAt < 1000 && progress < 99) return;
        lastProgressAt = now;
        void db.update(sessionVideoRenders).set({ progress, updatedAt: now }).where(eq(sessionVideoRenders.id, job.id));
      },
    });
    await db.update(sessionVideoRenders).set({ status: "completed", progress: 100, outputPath: path, updatedAt: Date.now() }).where(eq(sessionVideoRenders.id, job.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(sessionVideoRenders).set({ status: "failed", error: message.slice(0, 2000), updatedAt: Date.now() }).where(eq(sessionVideoRenders.id, job.id));
  } finally {
    await rm(join(DATA_DIR, "videos", "bundles", job.id), { recursive: true, force: true });
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (renderQueue.length) await renderOne(renderQueue.shift()!);
  } finally {
    draining = false;
  }
}

export async function queueVideoRender(sessionId: string) {
  await requireSession(sessionId);
  const [video] = await db.select().from(sessionVideos).where(eq(sessionVideos.sessionId, sessionId)).limit(1);
  const document = VideoDocumentSchema.parse(video?.document ?? {});
  const id = randomUUID();
  const now = Date.now();
  await db.insert(sessionVideoRenders).values([{ id, sessionId, revision: video?.revision ?? 0, document, status: "queued", progress: 0, outputPath: null, error: null, createdAt: now, updatedAt: now }]);
  renderQueue.push(id);
  void drain();
  return { id, status: "queued" as const };
}

export async function getVideoRender(sessionId: string, renderId: string) {
  const [row] = await db.select().from(sessionVideoRenders).where(and(eq(sessionVideoRenders.id, renderId), eq(sessionVideoRenders.sessionId, sessionId))).limit(1);
  if (!row || row.status !== "completed" || !row.outputPath) throw new HttpError("video is not ready", 404);
  const [bytes, info] = await Promise.all([readFile(row.outputPath), stat(row.outputPath)]);
  return { bytes, size: info.size };
}

export async function downloadVideoRender(sessionId: string, renderId: string) {
  return (await getVideoRender(sessionId, renderId)).bytes;
}

export async function recoverVideoRenders() {
  const interrupted = await db.update(sessionVideoRenders).set({ status: "failed", error: "Render interrupted by server restart; start a new render.", updatedAt: Date.now() })
    .where(eq(sessionVideoRenders.status, "rendering")).returning({ id: sessionVideoRenders.id });
  const queued = await db.select({ id: sessionVideoRenders.id }).from(sessionVideoRenders).where(eq(sessionVideoRenders.status, "queued"));
  renderQueue.push(...queued.map((row) => row.id));
  void drain();
  return interrupted.length;
}

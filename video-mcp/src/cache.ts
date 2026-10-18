import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CaptureResult, TtsResult } from "./types.js";
import type { VideoPaths } from "./storyboard.js";

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Write then rename, so a crash never leaves a half-written cache entry. */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}

const exists = (p: string) => stat(p).then(() => true, () => false);

// Entries store paths relative to the video folder, so moving the folder keeps the cache valid.
const rel = (p: VideoPaths, abs: string) => relative(p.dir, abs);
const abs = (p: VideoPaths, r: string) => resolve(p.dir, r);

// ---- tts: .cache/tts/<key>.<ext> + <key>.json -------------------------------

export function ttsOutBase(p: VideoPaths, key: string): string {
  return join(p.ttsDir, key);
}

export async function ttsGet(p: VideoPaths, key: string): Promise<TtsResult | undefined> {
  const e = await readJson<TtsResult>(join(p.ttsDir, `${key}.json`));
  if (!e) return undefined;
  const path = abs(p, e.path);
  return (await exists(path)) ? { ...e, path } : undefined;
}

export async function ttsPut(p: VideoPaths, key: string, r: TtsResult): Promise<void> {
  await writeJson(join(p.ttsDir, `${key}.json`), { ...r, path: rel(p, r.path) });
}

// ---- capture: .cache/capture/<key>/ (the provider's scratch dir) + result.json -

export function captureDirFor(p: VideoPaths, key: string): string {
  return join(p.captureDir, key);
}

export async function captureGet(p: VideoPaths, key: string): Promise<CaptureResult | undefined> {
  const e = await readJson<CaptureResult>(join(captureDirFor(p, key), "result.json"));
  if (!e) return undefined;
  const videoPath = abs(p, e.videoPath);
  return (await exists(videoPath)) ? { ...e, videoPath } : undefined;
}

export async function capturePut(p: VideoPaths, key: string, r: CaptureResult): Promise<void> {
  await writeJson(join(captureDirFor(p, key), "result.json"), { ...r, videoPath: rel(p, r.videoPath) });
}

/** A failed capture leaves a dir without result.json; start clean. */
export async function captureReset(p: VideoPaths, key: string): Promise<string> {
  const dir = captureDirFor(p, key);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---- build lock: one build per video across processes ------------------------
// Each thread has its own MCP process, so the in-process job map cannot see another thread's build.

export interface BuildLockHolder {
  pid: number;
  jobId: string;
  startedAtIso: string;
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
};

/**
 * Exclusive lock file `.cache/build.lock` (open "wx"). A lock whose pid is dead is taken over, so a crashed
 * build never wedges the video. Returns the release function. Synchronous, so startJob stays synchronous.
 * ponytail: two processes taking over the same stale lock at once can race; a retry on EEXIST covers the
 * common case, a real lock manager is not worth it for two threads building one video.
 */
export function acquireBuildLock(p: VideoPaths, me: BuildLockHolder): () => void {
  const path = join(p.cacheDir, "build.lock");
  mkdirSync(p.cacheDir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          // only remove our own lock, never one a successor took over
          if ((JSON.parse(readFileSync(path, "utf8")) as BuildLockHolder).jobId === me.jobId) unlinkSync(path);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: Partial<BuildLockHolder> = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // empty or half-written: its creator is between open and write, so a fresh one is held, an old one is junk
        if (Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 2000) throw new Error(`a build of "${p.name}" is starting in another process`);
      }
      if (typeof holder.pid === "number" && alive(holder.pid))
        throw new Error(`a build of "${p.name}" is already running in another process (job ${holder.jobId ?? "unknown"}, pid ${holder.pid}, started ${holder.startedAtIso ?? "?"})`);
      if (attempt >= 3) throw new Error(`could not take the build lock of "${p.name}" (${path})`);
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

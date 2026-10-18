import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireBuildLock, alive, readJson, writeJson } from "./cache.js";
import { redact } from "./exec.js";
import { type VideoPaths, videoPaths, videosRoot } from "./storyboard.js";
import type { JobKind, JobState, Quality, Stage } from "./types.js";

const jobs = new Map<string, JobState>();
const JOB_ID = /^[a-z0-9-]{8,64}$/;

const jobFile = (p: VideoPaths, id: string) => join(p.jobsDir, `${id}.json`);

/** Throws if this video already has a job of this kind running: two builds race on the cache dirs, two exports on the output file. */
export function startJob(
  p: VideoPaths,
  kind: JobKind,
  startedAtIso: string,
  work: (progress: (stage: Stage, fraction: number) => void) => Promise<unknown>,
  quality?: Quality,
): string {
  for (const j of jobs.values()) if (j.name === p.name && j.kind === kind && j.status === "running") throw new Error(`a ${kind} of "${p.name}" is already running (job ${j.id})`);
  const job: JobState = { id: randomUUID(), name: p.name, kind, quality, status: "running", pid: process.pid, stage: kind === "build" ? "validate" : "export", progress: 0, startedAtIso };
  // builds only: an export writes one file and is guarded in-process above
  const release = kind === "build" ? acquireBuildLock(p, { pid: process.pid, jobId: job.id, startedAtIso }) : () => {}; // throws naming the other holder
  jobs.set(job.id, job);
  const save = () => writeJson(jobFile(p, job.id), job).catch(() => {}); // mirror is best effort; memory is truth
  void save();
  void (async () => {
    try {
      job.result = await work((stage, fraction) => {
        job.stage = stage;
        job.progress = Math.round(fraction * 100) / 100;
        void save();
      });
      job.status = "done";
      job.stage = "done";
      job.progress = 1;
    } catch (e) {
      job.status = "failed";
      job.error = redact(e instanceof Error ? e.message : String(e));
    }
    release();
    await save();
  })();
  return job.id;
}

export async function getJob(cwd: string, id: string): Promise<JobState | undefined> {
  const live = jobs.get(id);
  if (live) return live;
  if (!JOB_ID.test(id)) return undefined;
  // After a restart the memory is gone; the mirror is all there is.
  let names: string[] = [];
  try {
    names = await readdir(videosRoot(cwd));
  } catch {}
  for (const n of names) {
    let p: VideoPaths;
    try {
      p = videoPaths(cwd, n);
    } catch {
      continue;
    }
    const j = await readJson<JobState>(jobFile(p, id));
    if (j) return j.status === "running" && !(j.pid && alive(j.pid)) ? { ...j, status: "failed", error: `interrupted: the video server restarted during this ${j.kind}` } : j;
  }
  return undefined;
}

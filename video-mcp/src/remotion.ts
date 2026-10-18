import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { readJson, writeJson } from "./cache.js";
import { findChrome, remotionCmd, studioHost } from "./config.js";
import { childEnv, redact, splitCommand } from "./exec.js";
import type { VideoPaths } from "./storyboard.js";
import type { Quality, StudioInfo } from "./types.js";

// Remotion runs as a subprocess and needs its own node_modules; this package never imports it and never installs it
// (its license also differs from the rest of the stack). Studio is `remotion studio`, exports are scripts/render.mjs.

const NEEDED = ["remotion", "react", "react-dom", "@remotion/cli", "@remotion/bundler", "@remotion/renderer"] as const;
const PORT_FROM = 3100;
const PORT_COUNT = 100;
const START_TIMEOUT_MS = 90_000; // first start bundles the composition
const RENDER_TIMEOUT_MS = 30 * 60 * 1000; // ponytail: fixed ceiling, no knob

// ---- installation ------------------------------------------------------------

/** The folder of `pkg` from the first node_modules at or above `dir`, as Node would resolve it. */
function packageDir(dir: string, pkg: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const p = join(d, "node_modules", pkg);
    if (existsSync(join(p, "package.json"))) return p;
    if (dirname(d) === d) return undefined;
  }
}

/** Packages Remotion needs that no node_modules from `dir` upwards provides. */
export function missingRemotionPackages(dir: string): string[] {
  return NEEDED.filter((p) => !packageDir(dir, p));
}

export function notInstalledMessage(dir: string, missing: string[]): string {
  return (
    `Remotion cannot run: ${missing.join(", ")} not installed. ` +
    `Run once: cd "${dir}" && npm install  (a package.json with remotion, @remotion/cli, @remotion/bundler, @remotion/renderer, react and react-dom is there), ` +
    `or install them in a parent folder of it. Nothing is installed automatically. ` +
    `Remotion's own license applies (free for individuals and small teams, paid above that).`
  );
}

/** For video_providers. `dir` is any folder below the videos root (packages resolve upwards from it). */
export function remotionInfo(dir: string): { installed: boolean; version?: string; hint: string } {
  const missing = missingRemotionPackages(dir);
  if (missing.length) return { installed: false, hint: notInstalledMessage(dir, missing) };
  let version: string | undefined;
  try {
    version = (JSON.parse(readFileSync(join(packageDir(dir, "remotion")!, "package.json"), "utf8")) as { version?: string }).version;
  } catch {}
  return { installed: true, version, hint: "" };
}

/** VIDEO_REMOTION_CMD wins; the default is npx without downloading anything. */
export function remotionBase(): string[] {
  const o = remotionCmd();
  return o ? splitCommand(o) : ["npx", "--no-install", "remotion"];
}

// ---- studio ------------------------------------------------------------------

export function studioArgv(port: number, chrome?: string): { cmd: string; args: string[] } {
  const [cmd, ...pre] = remotionBase();
  return { cmd, args: [...pre, "studio", "src/index.ts", "--port", String(port), "--no-open", ...(chrome ? [`--browser-executable=${chrome}`] : [])] };
}

export interface StudioState {
  pid: number;
  port: number;
  host: string;
  url: string;
  startedAtIso: string;
}

// Remotion binds Studio to every interface and has no host option, so a preload rewrites the wildcard bind to the
// wanted host (loopback by default). Without it Studio, which can write files and render, would be open to the LAN.
const HOST_SHIM = `const net = require("node:net");
const host = process.env.VIDEO_STUDIO_HOST || "127.0.0.1";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  const o = a[0];
  if (o && typeof o === "object") {
    if (!o.path && (!o.host || o.host === "0.0.0.0" || o.host === "::")) a[0] = { ...o, host };
  } else if (typeof o === "number" || typeof o === "string" && /^\\d+$/.test(o)) {
    a.splice(1, typeof a[1] === "string" ? 1 : 0, host);
  }
  return listen.apply(this, a);
};
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A recycled pid must not get our SIGTERM. Where /proc is readable the process has to be a studio; elsewhere trust the pid. */
function looksLikeStudio(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("studio");
  } catch {
    return true;
  }
}

const dialHost = (host: string) => (host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host);

function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: dialHost(host), port });
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(1000, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen({ host: dialHost(host), port }, () => s.close(() => done(true)));
  });
}

export const readStudioState = (p: VideoPaths) => readJson<StudioState>(p.studioState);

/** Running means the pid is alive AND the port answers: a state file outlives a crash. */
export async function studioStatus(p: VideoPaths): Promise<StudioInfo & { pid?: number }> {
  const s = await readStudioState(p);
  if (!s || !alive(s.pid) || !(await portAnswers(s.host, s.port))) return { running: false };
  return { running: true, url: s.url, port: s.port, pid: s.pid };
}

// Ports handed out by this process whose Studio is not listening yet: two videos on the same hash offset must not both see it "free".
const claimed = new Set<number>();

/** First free port in 3100-3199, starting at an offset derived from the name so two videos rarely contend. */
async function pickPort(name: string, host: string): Promise<number> {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < PORT_COUNT; i++) {
    const port = PORT_FROM + ((h + i) % PORT_COUNT);
    if (!claimed.has(port) && (await portFree(host, port))) {
      claimed.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${PORT_FROM}-${PORT_FROM + PORT_COUNT - 1} for Studio`);
}

const killGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
};

// Start and stop of one video run one at a time: the status check, the port pick and the state file are a unit.
// ponytail: in-process only; two MCP processes starting the same video at once can still race (the loser errors, and only removes a state file that is its own).
const queues = new Map<string, Promise<unknown>>();
function serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(name, run);
  void run.then(
    () => queues.get(name) === run && queues.delete(name),
    () => queues.get(name) === run && queues.delete(name),
  );
  return run;
}

/** Removes studio.json only while it still names `pid`: a successor's state is not ours to delete. */
async function dropState(p: VideoPaths, pid: number): Promise<void> {
  if ((await readStudioState(p))?.pid === pid) await rm(p.studioState, { force: true });
}

/**
 * Starts `remotion studio` detached (it must outlive this MCP process) unless it already runs. Argv array, no shell.
 * Throws with the log tail when it dies or does not answer in time.
 */
export const startStudio = (p: VideoPaths): Promise<StudioInfo> => serial(p.name, () => doStart(p));

async function doStart(p: VideoPaths): Promise<StudioInfo> {
  const now = await studioStatus(p);
  if (now.running) return now;
  if (!existsSync(join(p.studioDir, "src", "index.ts"))) throw new Error(`no studio project at ${p.studioDir}; run video_init or video_build first`);
  if (!remotionCmd()) {
    const missing = missingRemotionPackages(p.studioDir);
    if (missing.length) throw new Error(notInstalledMessage(p.studioDir, missing));
  }
  const host = studioHost();
  const port = await pickPort(p.name, host);
  try {
    return await spawnStudio(p, host, port);
  } finally {
    claimed.delete(port);
  }
}

async function spawnStudio(p: VideoPaths, host: string, port: number): Promise<StudioInfo> {
  const { cmd, args } = studioArgv(port, findChrome());
  await mkdir(p.cacheDir, { recursive: true });
  const shim = join(p.cacheDir, "studio-host.cjs");
  await writeFile(shim, HOST_SHIM);
  const logPath = join(p.cacheDir, "studio.log");
  const log = openSync(logPath, "w");
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: p.studioDir,
      env: childEnv({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require "${shim}"`.trim(), VIDEO_STUDIO_HOST: host }),
      stdio: ["ignore", log, log],
      detached: true,
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  let exited: number | null | undefined;
  child.once("exit", (c) => (exited = c ?? -1));
  child.once("error", () => (exited = -1));
  const tail = () => {
    try {
      return redact(readFileSync(logPath, "utf8").trim().split("\n").slice(-8).join("\n"));
    } catch {
      return "";
    }
  };
  const pid = child.pid;
  if (!pid) throw new Error(`could not start Studio: ${cmd} did not spawn`);
  const url = `http://${dialHost(host) === "127.0.0.1" ? "localhost" : dialHost(host)}:${port}`;
  const state: StudioState = { pid, port, host, url, startedAtIso: new Date().toISOString() };
  await writeJson(p.studioState, state);
  for (const t0 = Date.now(); Date.now() - t0 < START_TIMEOUT_MS; await new Promise((r) => setTimeout(r, 400))) {
    if (exited !== undefined) {
      killGroup(pid, "SIGKILL"); // the npx/sh wrappers can outlive the node that died
      await dropState(p, pid);
      throw new Error(`Studio exited with ${exited} while starting: ${tail()}`);
    }
    if (await portAnswers(host, port)) return { running: true, url, port };
  }
  killGroup(pid, "SIGKILL");
  await dropState(p, pid);
  throw new Error(`Studio did not answer on port ${port} within ${START_TIMEOUT_MS / 1000}s: ${tail()}`);
}

/** Kills the whole process group (npx, node, the bundler's workers). */
export const stopStudio = (p: VideoPaths): Promise<{ stopped: boolean }> => serial(p.name, () => doStop(p));

async function doStop(p: VideoPaths): Promise<{ stopped: boolean }> {
  const s = await readStudioState(p);
  await rm(p.studioState, { force: true });
  if (!s || !alive(s.pid) || !looksLikeStudio(s.pid)) return { stopped: false };
  killGroup(s.pid, "SIGTERM");
  for (let i = 0; i < 15 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive(s.pid)) killGroup(s.pid, "SIGKILL");
  return { stopped: true };
}

// ---- render ------------------------------------------------------------------

export interface RenderArgs {
  /** The studio folder: render.mjs runs with it as cwd. */
  studioDir: string;
  mode: "still" | "media";
  propsFile: string;
  /** media: a file. still: a directory (<out>/<frame>.png). */
  out: string;
  /** media only, inclusive. */
  frames?: { from: number; to: number };
  /** still only. */
  frame?: number[];
  quality?: Quality;
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Runs `node scripts/render.mjs` (the only code that touches Remotion's Node API) and follows its JSON lines.
 * Resolves with the output path; rejects with the script's own message. Never inherits secrets (childEnv).
 */
export function spawnRender(a: RenderArgs, onProgress?: (fraction: number) => void): Promise<{ out: string }> {
  const missing = missingRemotionPackages(a.studioDir);
  if (missing.length) return Promise.reject(new Error(notInstalledMessage(a.studioDir, missing)));
  const chrome = findChrome();
  const args = [
    join("scripts", "render.mjs"),
    "--mode", a.mode,
    "--props", resolve(a.propsFile),
    "--out", resolve(a.out),
    ...(a.frames ? ["--frames", `${a.frames.from}-${a.frames.to}`] : []),
    ...(a.frame?.length ? ["--frame", a.frame.join(",")] : []),
    ...(a.quality ? ["--quality", a.quality] : []),
    ...(chrome ? ["--chrome", chrome] : []),
    ...(a.concurrency ? ["--concurrency", String(a.concurrency)] : []),
  ];
  return new Promise((done, fail) => {
    if (a.signal?.aborted) return fail(new Error("render aborted"));
    const child = spawn(process.execPath, args, { cwd: a.studioDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out: string | undefined;
    let error: string | undefined;
    let stderr = "";
    let killed: string | undefined;
    const stop = (why: string) => {
      if (killed) return;
      killed = why;
      if (child.pid) killGroup(child.pid, "SIGTERM");
      setTimeout(() => child.pid && killGroup(child.pid, "SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(() => stop(`render timed out after ${RENDER_TIMEOUT_MS / 60000} min`), RENDER_TIMEOUT_MS);
    const onAbort = () => stop("render aborted");
    a.signal?.addEventListener("abort", onAbort, { once: true });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const m = JSON.parse(line) as { progress?: number; done?: boolean; out?: string; error?: string };
        if (typeof m.progress === "number") onProgress?.(Math.min(1, Math.max(0, m.progress)));
        if (m.done) out = m.out;
        if (m.error) error = m.error;
      } catch {} // not ours (a library printing to stdout)
    });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-8192)));
    child.once("error", (e) => settle(() => fail(new Error(redact(`render: ${e.message}`)))));
    child.once("close", (code) =>
      settle(() => {
        if (killed) return fail(new Error(killed));
        if (code === 0 && out) return done({ out });
        fail(new Error(redact(`render failed: ${error ?? (stderr.trim().split("\n").slice(-4).join("\n") || `exit ${code}`)}`)));
      }),
    );
    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.signal?.removeEventListener("abort", onAbort);
      fn();
    }
  });
}

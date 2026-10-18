import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { secretValues } from "./config.js";

/** The loopback path segment carries the per-thread key: /hm/<key>/<session>. */
const LOOPBACK_KEY = /\/hm\/[^/\s"'?#]+\//g;

/** Strip every configured key, the loopback key and the TTS base URL's credentials from text before it reaches an error, log or job file. */
export function redact(text: string): string {
  let out = text.replace(LOOPBACK_KEY, "/hm/***/");
  for (const s of secretValues()) out = out.split(s).join("***");
  return out;
}

export class ExecError extends Error {
  code: number | null;
  stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  input?: string;
  timeoutMs?: number;
  /** SIGTERM to SIGKILL grace on timeout/abort. Default 2000. */
  killGraceMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const STDOUT_CAP = 16 * 1024 * 1024;
const STDERR_KEEP = 64 * 1024;
// Credentials this process uses itself but no child (ffmpeg, npx remotion running project code, Chromium) may see.
// HARNESS_URL embeds the loopback key; VIDEO_TTS_BASE_URL may embed userinfo or a token.
const NEVER_INHERIT = ["HARNESS_URL", "VIDEO_TTS_API_KEY", "ELEVENLABS_API_KEY", "VIDEO_TTS_BASE_URL"];

/** process.env minus the credentials above, plus `extra` (explicit wins). Also what playwright's chromium.launch gets. */
export function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NEVER_INHERIT.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * argv array only, never a shell. Rejects with ExecError (stderr redacted) on spawn failure, timeout, abort or non-zero exit.
 * The child leads its own process group so a timeout or abort takes its grandchildren (npx -> renderer -> Chrome) with it.
 * ponytail: POSIX only (detached + process.kill(-pid)); Windows would need taskkill /T.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ExecError(`${cmd} aborted`, null, ""));
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(opts.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let killedBy: "timeout" | "abort" | undefined;
    let settled = false;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        child.kill(sig);
      }
    };
    const stop = (why: "timeout" | "abort") => {
      if (killedBy) return;
      killedBy = why;
      killGroup("SIGTERM");
      // Not cleared on exit: a grandchild may outlive the leader and ignore SIGTERM.
      setTimeout(() => killGroup("SIGKILL"), opts.killGraceMs ?? 2000).unref();
    };
    const timer = opts.timeoutMs ? setTimeout(() => stop("timeout"), opts.timeoutMs) : undefined;
    const onAbort = () => stop("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      fn();
    };
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-STDERR_KEEP);
    });
    child.on("error", (e) => settle(() => reject(new ExecError(redact(`${cmd}: ${e.message}`), null, redact(stderr)))));
    const finish = (code: number | null) =>
      settle(() => {
        const err = redact(stderr);
        if (killedBy === "timeout") return reject(new ExecError(`${cmd} timed out after ${opts.timeoutMs}ms`, code, err));
        if (killedBy === "abort") return reject(new ExecError(`${cmd} aborted`, code, err));
        if (code !== 0) return reject(new ExecError(redact(`${cmd} exited with ${code}: ${err.trim().split("\n").slice(-6).join("\n")}`), code, err));
        resolve({ stdout, stderr: err });
      });
    child.on("close", finish);
    // After a kill, settle on the leader's exit: a stray grandchild holding the pipes must not keep us waiting.
    child.on("exit", (code) => killedBy && finish(code));
    child.stdin.on("error", () => {}); // child may exit before reading its input
    child.stdin.end(opts.input);
  });
}

/** Resolve an executable on PATH (or check a path) without a shell. */
export async function which(cmd: string): Promise<string | undefined> {
  const candidates = cmd.includes("/") ? [cmd] : (process.env.PATH ?? "").split(delimiter).map((d) => join(d, cmd));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {}
  }
  return undefined;
}

/** "cmd --flag 'a b'" to argv. For the VIDEO_*_CMD overrides. ponytail: quotes only, no escapes. */
export function splitCommand(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

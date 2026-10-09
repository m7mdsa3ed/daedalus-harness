import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../config.js";
import type { Handle, HandleEvents, HandleInfo, Sandbox, SpawnSpec } from "./types.js";

/* Agents run under a detached per-agent host (../agent-host.ts) that buffers
   their stdout, so a server restart reattaches instead of losing them. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The host runs as built JS next to us, or as the .ts through tsx under dev/tests. */
function hostCommand(): { command: string; args: string[] } {
  const here = import.meta.url;
  const ts = here.endsWith(".ts");
  const file = fileURLToPath(new URL(`../agent-host.${ts ? "ts" : "js"}`, here));
  return { command: process.execPath, args: ts ? ["--import", "tsx", file] : [file] };
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Frame = { t: string; [k: string]: any };

class HostedHandle implements Handle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly exited: Promise<number | null>;
  lossy = false;
  offset: number;
  running = true;
  private detached = false;
  private done = false;
  private replayed = false;
  private resolveExit!: (c: number | null) => void;
  private readonly listeners: { [E in keyof HandleEvents]: HandleEvents[E][] } = { exit: [], close: [], error: [] };
  private exitFrame: Frame | null = null;

  constructor(
    readonly id: string,
    private readonly sock: Socket,
    from: number,
    readonly info: HandleInfo | undefined,
  ) {
    this.offset = from;
    this.exited = new Promise((r) => (this.resolveExit = r));
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.send({ t: "write", data: Buffer.from(chunk).toString("utf8") });
        cb();
      },
    });
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (l.trim()) this.frame(JSON.parse(l) as Frame);
      }
    });
    sock.on("close", () => {
      // the host vanished without an exit frame: the agent is gone too
      if (!this.detached) this.finish(this.exitFrame ?? { t: "exit", code: null, signal: null });
    });
  }

  /** Waits for the attach answer, at most `timeoutMs`. */
  attach(from: number, timeoutMs: number): Promise<void> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.sock.destroy();
        rej(new Error(`agent host ${this.id} did not answer attach within ${timeoutMs}ms`));
      }, timeoutMs);
      this.onAttached = () => {
        clearTimeout(timer);
        res();
      };
      this.sock.once("close", () => {
        clearTimeout(timer);
        rej(new Error("agent host closed before attaching"));
      });
      this.send({ t: "attach", fromOffset: from });
    });
  }
  private onAttached: () => void = () => {};

  get pid(): number | undefined {
    return this.info?.pid;
  }

  private send(o: object): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(o) + "\n");
  }

  private frame(m: Frame): void {
    switch (m.t) {
      case "attached":
        this.lossy = !!m.lossy;
        // lossy: the host's oldest surviving line is the first we can see
        if (this.lossy && m.firstOffset > this.offset) this.offset = m.firstOffset;
        this.onAttached();
        break;
      case "data":
        if (m.offset < this.offset) break;
        this.offset = m.offset + 1;
        this.stdout.write(m.line + "\n");
        break;
      case "stderr":
        // live chunks always; the tail replay only once (it is what we missed before attaching)
        if (m.replay) {
          if (this.replayed) break;
          this.replayed = true;
        }
        if (m.data) this.stderr.write(m.data);
        break;
      case "exit":
        this.finish(m);
        break;
    }
  }

  private finish(m: Frame): void {
    if (this.done) return;
    this.done = true;
    this.running = false;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit(m.code ?? null);
    if (m.error) for (const l of this.listeners.error) l(Object.assign(new Error(m.error), { code: "ENOENT" }));
    for (const l of this.listeners.exit) l(m.code ?? null, m.signal ?? null);
    for (const l of this.listeners.close) l(m.code ?? null, m.signal ?? null);
    this.sock.destroy();
  }

  on<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this {
    (this.listeners[event] as HandleEvents[E][]).push(listener);
    return this;
  }
  off<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this {
    const a = this.listeners[event] as HandleEvents[E][];
    const i = a.indexOf(listener);
    if (i >= 0) a.splice(i, 1);
    return this;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.send({ t: "kill", signal });
  }
  /** Close the socket only; the host and the agent keep running, buffering. */
  detach(): void {
    this.detached = true;
    this.sock.destroy();
  }
}

export interface HostedOptions {
  /** Where <id>.sock/<id>.json live. Default: <data>/agents. */
  dir?: string;
  /** Bound on connect and on the host's `attached` answer. Default 5 s, or DAEDALUS_HOST_ATTACH_TIMEOUT_MS. */
  attachTimeoutMs?: number;
}

export class HostedSandbox implements Sandbox {
  private readonly dir: string;
  private readonly attachTimeoutMs: number;

  constructor(opts: HostedOptions = {}) {
    this.dir = opts.dir ?? join(DATA_DIR, "agents");
    const env = Number(process.env.DAEDALUS_HOST_ATTACH_TIMEOUT_MS);
    this.attachTimeoutMs = opts.attachTimeoutMs ?? (env > 0 ? env : 5000);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }
  private path(id: string, ext: "sock" | "json"): string {
    return join(this.dir, `${id}.${ext}`);
  }

  private async open(id: string, from: number, info?: HandleInfo): Promise<HostedHandle> {
    const sock = connect(this.path(id, "sock"));
    const ms = this.attachTimeoutMs;
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        sock.destroy();
        rej(new Error(`agent host ${id} did not accept a connection within ${ms}ms`));
      }, ms);
      sock.once("connect", () => {
        clearTimeout(timer);
        res();
      });
      sock.once("error", (e) => {
        clearTimeout(timer);
        rej(e);
      });
    });
    const h = new HostedHandle(id, sock, from, info);
    try {
      await h.attach(from, ms);
    } catch (e) {
      sock.destroy();
      throw e;
    }
    return h;
  }

  async spawn(spec: SpawnSpec): Promise<Handle> {
    this.ensureDir();
    const id = randomUUID();
    const host = hostCommand();
    const p = spawn(host.command, [...host.args, "--id", id, "--dir", this.dir], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    p.unref();
    p.stdin.end(JSON.stringify(spec) + "\n");
    const t = Date.now();
    while (!existsSync(this.path(id, "json"))) {
      if (p.exitCode !== null) throw new Error(`agent host exited (${p.exitCode}) before it was ready`);
      if (Date.now() - t > 10_000) {
        p.kill();
        throw new Error("agent host did not become ready");
      }
      await sleep(10);
    }
    const read = this.read(id);
    // the launcher keeps the full spec in memory; the file only has the redacted one
    const info: HandleInfo = { ...(read ?? { id }), spec };
    if (info.error) {
      // attaching makes the host send `exit` and clean itself up
      try {
        (await this.open(id, 0, info)).detach();
      } catch {
        /* the host is going away anyway */
      }
      throw new Error(info.error);
    }
    return this.open(id, 0, info);
  }

  private read(id: string): HandleInfo | null {
    try {
      const j = JSON.parse(readFileSync(this.path(id, "json"), "utf8"));
      return {
        id,
        pid: j.pid ?? undefined,
        hostPid: j.hostPid,
        startedAt: j.startedAt,
        spec: j.spec,
        ...(j.exited ? { finished: true } : {}),
        ...(j.error ? { error: j.error } : {}),
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<HandleInfo[]> {
    if (!existsSync(this.dir)) return [];
    const out: HandleInfo[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      let j: { hostPid?: number } | null = null;
      try {
        j = JSON.parse(readFileSync(this.path(id, "json"), "utf8"));
      } catch {
        continue; // half-written or being removed
      }
      if (!alive(j?.hostPid)) {
        rmSync(this.path(id, "json"), { force: true });
        rmSync(this.path(id, "sock"), { force: true });
        continue;
      }
      if (!existsSync(this.path(id, "sock"))) continue;
      const info = this.read(id);
      if (info) out.push(info);
    }
    return out;
  }

  async attach(id: string, fromOffset: number): Promise<Handle> {
    return this.open(id, fromOffset, this.read(id) ?? undefined);
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { Handle, HandleEvents, HandleInfo, Sandbox, SpawnSpec } from "./types.js";

class DirectHandle implements Handle {
  readonly id = randomUUID();
  readonly exited: Promise<number | null>;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get stdin(): Writable {
    return this.child.stdin;
  }
  get stdout(): Readable {
    return this.child.stdout;
  }
  get stderr(): Readable {
    return this.child.stderr;
  }
  readonly offset = 0;
  readonly lossy = false;
  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  on<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this {
    this.child.on(event, listener);
    return this;
  }
  off<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this {
    this.child.off(event, listener);
    return this;
  }
  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }
  /** A direct child cannot outlive the server's pipes, so letting go is ending it. */
  detach(): void {
    this.child.kill();
  }
}

/** Today's behaviour: a plain child process of the server. */
export class DirectSandbox implements Sandbox {
  async spawn(spec: SpawnSpec): Promise<Handle> {
    return new DirectHandle(
      spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams,
    );
  }
  async list(): Promise<HandleInfo[]> {
    return [];
  }
  async attach(): Promise<Handle> {
    throw new Error("DirectSandbox cannot attach: its processes die with the server");
  }
}

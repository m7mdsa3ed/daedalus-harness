import type { Readable, Writable } from "node:stream";

/** What a sandbox is asked to start: a resolved command, its env (merged over
    the server's own by the sandbox) and cwd. stdio is always three pipes. */
export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** The lifecycle events a handle reports, with the shapes ChildProcess gives. */
export interface HandleEvents {
  /** The process is gone; stdio may still be draining. */
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Stdio has closed too. */
  close: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** The process could not start (bad binary, cwd, permissions). */
  error: (error: NodeJS.ErrnoException) => void;
}

/** A running agent process, however it is hosted. */
export interface Handle {
  readonly id: string;
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles with the exit code (null for a signal or a failed start). */
  readonly exited: Promise<number | null>;
  /** True until the process has exited or failed to start. */
  readonly running: boolean;
  on<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this;
  off<E extends keyof HandleEvents>(event: E, listener: HandleEvents[E]): this;
  kill(signal?: NodeJS.Signals): void;
  /** Next stdout line offset to ask a later `attach` for (lines consumed so far). */
  readonly offset: number;
  /** True when an attach asked for lines the host had already dropped. */
  readonly lossy: boolean;
  /** What this handle was started with, where the sandbox keeps it. */
  readonly info?: HandleInfo;
  /** Let go of the process without ending it, where the sandbox can keep it
      running for a later `attach`. A sandbox that cannot (Direct) kills it. */
  detach(): void;
}

/** A spawn spec with the env values dropped: what a sandbox may keep on disk. */
export interface SpawnSummary {
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
}

export interface HandleInfo {
  id: string;
  pid?: number;
  startedAt?: number;
  /** The full spec only on the handle that launched it; a listed/adopted one is redacted. */
  spec?: SpawnSpec | SpawnSummary;
  hostPid?: number;
  /** The agent has exited and only its tail is left to read. */
  finished?: boolean;
  /** The agent failed to start. */
  error?: string;
}

export interface Sandbox {
  spawn(spec: SpawnSpec): Promise<Handle>;
  list(): Promise<HandleInfo[]>;
  attach(id: string, fromOffset: number): Promise<Handle>;
}

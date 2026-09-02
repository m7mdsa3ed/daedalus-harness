/* ── Terminals ──
 *
 * A PTY per terminal panel, rooted in the project's `cwd`.
 *
 * **Not on the thread socket.** `protocol.ts` is a command/event protocol with
 * a journal, replay on attach and a monotonic cursor; terminal traffic is a raw
 * byte stream at whatever rate a build tool feels like emitting. Putting it in
 * `session_events` would mean persisting megabytes of ANSI to SQLite for
 * something nobody replays, and the two lifecycles do not line up either — a
 * terminal outlives the turn that opened it and belongs to a project rather
 * than to a session.
 *
 * **Closing a panel and killing a process are different things.** Closing
 * detaches: the PTY keeps running, its output keeps filling the scrollback, and
 * reconnecting within `DETACH_GRACE_MS` picks it back up where it was. That is
 * the whole point of a terminal on a *server* — you can close the laptop
 * mid-build. Killing is explicit, and so is the sweep that eventually reclaims
 * one nobody came back for.
 *
 * Everything here is bounded: how many terminals a project may have, how much
 * scrollback is kept, how long a detached one survives, and how long an idle
 * one lives. A terminal is a shell that outlives the request that made it, so
 * every one of those is a leak if it is left open-ended.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import * as pty from "node-pty";

import { getProject } from "./projects.js";
import { WorkspaceError, projectRoot } from "./workspace-fs.js";

/** Terminals one project may have at once. */
const MAX_PER_PROJECT = 8;
/** Scrollback replayed to a (re)attaching client, in bytes. */
const SCROLLBACK_BYTES = 256 * 1024;
/** How long a detached terminal keeps running before it is reclaimed. */
const DETACH_GRACE_MS = 10 * 60 * 1000;
/** How long a terminal with no output and no peer lives at all. */
const IDLE_MS = 6 * 60 * 60 * 1000;
/** How often the sweeper looks for expired terminals. */
const SWEEP_MS = 60 * 1000;

export interface TerminalInfo {
  id: string;
  projectId: string;
  title: string;
  cols: number;
  rows: number;
  /** Set once the process has gone; the row survives so the panel can say so. */
  exitCode: number | null;
  attached: boolean;
  /** What this terminal is for. Absent for a shell the user opened; `dev` is
      the project's dev server (`dev-server.ts`), which owns its lifecycle. */
  role?: TerminalRole;
}

export type TerminalRole = "dev" | "install" | "build";

interface Terminal {
  id: string;
  projectId: string;
  title: string;
  proc: pty.IPty | null;
  peer: WebSocket | null;
  /** Ring of recent output, trimmed to SCROLLBACK_BYTES. */
  scrollback: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  /** When the last peer left, or null while one is attached. */
  detachedAt: number | null;
  lastActivity: number;
  role?: TerminalRole;
  /** Exempt from the sweeper: some module owns this terminal's lifetime and
      kills it explicitly. A dev server is the case — it is *supposed* to sit
      there detached for hours with nothing to say. */
  pinned: boolean;
  /** Output listeners besides the attached peer — the dev-server module reads
      the stream for the port a server announces. Fed the same chunks. */
  taps: Set<(chunk: string) => void>;
  exits: Set<(code: number) => void>;
}

const terminals = new Map<string, Terminal>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const fail = (status: 400 | 403 | 404 | 409 | 413, message: string) =>
  new WorkspaceError(message, status);

/** The shell to run. `SHELL` is what the user actually uses; the fallbacks are
    only for a stripped environment (a container, a systemd unit). With a
    `command` the shell runs it and exits — still a login shell, for the same
    PATH reason. */
function shellFor(command?: string): { file: string; args: string[] } {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
  // A login shell reads the profile, which is where PATH usually gets its
  // interesting entries — without it `pnpm` is frequently just missing.
  if (process.platform === "win32") return { file: shell, args: command ? ["-Command", command] : [] };
  return { file: shell, args: command ? ["-l", "-c", command] : ["-l"] };
}

/** Read a terminal's output alongside its peer. Returns the unsubscribe. The
    scrollback so far is handed over first, so a late subscriber sees the line
    it was looking for even if it already went by. */
export function tapTerminal(
  terminalId: string,
  fn: (chunk: string) => void,
  options: { replay?: boolean } = {},
): () => void {
  const terminal = terminals.get(terminalId);
  if (!terminal) return () => {};
  if (options.replay && terminal.scrollback) fn(terminal.scrollback);
  terminal.taps.add(fn);
  return () => {
    terminal.taps.delete(fn);
  };
}

/** Told once, with the exit code, when the process ends — or immediately if it
    already has. Returns the unsubscribe. */
export function onTerminalExit(terminalId: string, fn: (code: number) => void): () => void {
  const terminal = terminals.get(terminalId);
  if (!terminal) return () => {};
  if (terminal.exitCode !== null) {
    fn(terminal.exitCode);
    return () => {};
  }
  terminal.exits.add(fn);
  return () => {
    terminal.exits.delete(fn);
  };
}

/** The recent output, for a module that wants the tail rather than a stream. */
export function terminalScrollback(terminalId: string): string {
  return terminals.get(terminalId)?.scrollback ?? "";
}

/** Write to the process — `q` to a vite server, a newline to a paused
    installer. The peer's frames come through `attachTerminal`; this is for
    the server's own modules. */
export function writeTerminal(terminalId: string, data: string): boolean {
  const terminal = terminals.get(terminalId);
  if (!terminal?.proc) return false;
  terminal.proc.write(data);
  return true;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const terminal of [...terminals.values()]) {
      if (terminal.pinned) continue;
      const detachedTooLong =
        terminal.detachedAt !== null && now - terminal.detachedAt > DETACH_GRACE_MS;
      const idleTooLong = now - terminal.lastActivity > IDLE_MS;
      if (detachedTooLong || idleTooLong) {
        console.log(
          `[terminal ${terminal.id}] reclaimed (${detachedTooLong ? "detached" : "idle"})`,
        );
        killTerminal(terminal.id);
      }
    }
    if (terminals.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, SWEEP_MS);
  sweeper.unref?.();
}

export function listTerminals(projectId: string): TerminalInfo[] {
  return [...terminals.values()]
    .filter((terminal) => terminal.projectId === projectId)
    .map(describe);
}

const describe = (terminal: Terminal): TerminalInfo => ({
  id: terminal.id,
  projectId: terminal.projectId,
  title: terminal.title,
  cols: terminal.cols,
  rows: terminal.rows,
  exitCode: terminal.exitCode,
  attached: terminal.peer !== null,
  ...(terminal.role ? { role: terminal.role } : {}),
});

export interface CreateTerminalOptions {
  title?: string;
  cols?: number;
  rows?: number;
  /** Run this instead of an interactive prompt: the shell is started with
      `-c`, so the user's PATH and profile still apply (`pnpm` is found the way
      it is found in their own terminal), and the terminal ends when it does. */
  command?: string;
  role?: TerminalRole;
  /** See `Terminal.pinned`. Only meaningful with a `command` — an interactive
      shell nobody comes back to should still be reclaimed. */
  pinned?: boolean;
  /** Extra environment for the process. */
  env?: Record<string, string>;
}

export function createTerminal(projectId: string, options: CreateTerminalOptions = {}): TerminalInfo {
  // Resolves the project and its cwd, and throws the 404 if either is gone.
  const cwd = projectRoot(projectId);
  const project = getProject(projectId);

  const existing = listTerminals(projectId);
  if (existing.length >= MAX_PER_PROJECT)
    throw fail(409, `this project already has ${MAX_PER_PROJECT} terminals`);

  const cols = clamp(options.cols ?? 80, 2, 500);
  const rows = clamp(options.rows ?? 24, 2, 200);
  const { file, args } = shellFor(options.command);

  const id = randomUUID();
  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    env: {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      // So a shell prompt, and anything that greps the environment, can say
      // where it is running. Nothing reads these back.
      DAEDALUS_PROJECT: project?.name ?? projectId,
      ...options.env,
    },
  });

  const terminal: Terminal = {
    id,
    projectId,
    title: options.title ?? `Terminal ${existing.length + 1}`,
    proc,
    peer: null,
    scrollback: "",
    cols,
    rows,
    exitCode: null,
    detachedAt: Date.now(),
    lastActivity: Date.now(),
    role: options.role,
    pinned: options.pinned === true && !!options.command,
    taps: new Set(),
    exits: new Set(),
  };
  terminals.set(id, terminal);
  startSweeper();

  proc.onData((chunk) => {
    terminal.lastActivity = Date.now();
    terminal.scrollback = trim(terminal.scrollback + chunk);
    send(terminal.peer, { t: "data", data: chunk });
    for (const tap of terminal.taps) tap(chunk);
  });

  proc.onExit(({ exitCode, signal }) => {
    terminal.exitCode = exitCode;
    terminal.proc = null;
    terminal.lastActivity = Date.now();
    send(terminal.peer, { t: "exit", exitCode, signal: signal ?? null });
    for (const fn of terminal.exits) fn(exitCode);
    /* The row stays: a peer attaching after the process died should be told it
       died, with the output that led there, rather than getting a 404 that
       reads like the terminal never existed. The sweeper collects it. */
  });

  return describe(terminal);
}

/** Keep the tail. Cutting at a byte boundary can split a UTF-8 sequence or an
    escape, so the cut is moved forward to the next newline where there is one
    nearby — a mangled first line beats a mangled colour state for the rest. */
function trim(text: string): string {
  if (text.length <= SCROLLBACK_BYTES) return text;
  const cut = text.length - SCROLLBACK_BYTES;
  const newline = text.indexOf("\n", cut);
  return text.slice(newline >= 0 && newline - cut < 4096 ? newline + 1 : cut);
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;

type ServerFrame =
  | { t: "ready"; terminal: TerminalInfo; scrollback: string }
  | { t: "data"; data: string }
  | { t: "exit"; exitCode: number; signal: number | null }
  | { t: "error"; message: string };

function send(peer: WebSocket | null, frame: ServerFrame): void {
  if (!peer || peer.readyState !== peer.OPEN) return;
  try {
    peer.send(JSON.stringify(frame));
  } catch {
    /* the socket is going away; the close handler will detach it */
  }
}

/**
 * Attach a socket to a terminal.
 *
 * One peer at a time, deliberately: a PTY has a single cursor and a single
 * `stdin`, so two browsers typing into one shell is not a feature, it is two
 * people fighting. A second attach takes over and the first is told why.
 */
export function attachTerminal(terminalId: string, projectId: string, ws: WebSocket): string | null {
  const terminal = terminals.get(terminalId);
  if (!terminal) return "no such terminal";
  /* The project is part of the check, not just the id: a terminal id from one
     project must not be usable against another, or the panel's authorization
     is decorative. */
  if (terminal.projectId !== projectId) return "terminal belongs to another project";

  if (terminal.peer && terminal.peer !== ws) {
    send(terminal.peer, { t: "error", message: "This terminal was opened somewhere else." });
    try {
      terminal.peer.close(4009, "attached elsewhere");
    } catch {
      /* already gone */
    }
  }
  terminal.peer = ws;
  terminal.detachedAt = null;
  terminal.lastActivity = Date.now();

  send(ws, { t: "ready", terminal: describe(terminal), scrollback: terminal.scrollback });
  if (terminal.exitCode !== null) send(ws, { t: "exit", exitCode: terminal.exitCode, signal: null });

  ws.on("message", (raw) => {
    let frame: { t?: string; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      frame = JSON.parse(String(raw)) as typeof frame;
    } catch {
      return;
    }
    const live = terminals.get(terminalId);
    if (!live?.proc) return;
    live.lastActivity = Date.now();
    if (frame.t === "data" && typeof frame.data === "string") live.proc.write(frame.data);
    else if (frame.t === "resize") {
      live.cols = clamp(Number(frame.cols), 2, 500);
      live.rows = clamp(Number(frame.rows), 2, 200);
      try {
        live.proc.resize(live.cols, live.rows);
      } catch {
        /* the process died between the check and the resize */
      }
    }
  });

  const detach = () => {
    const live = terminals.get(terminalId);
    if (!live || live.peer !== ws) return;
    live.peer = null;
    live.detachedAt = Date.now();
  };
  ws.on("close", detach);
  ws.on("error", detach);
  return null;
}

/** Kill the process and forget the terminal. Explicit — closing a panel does
    not come through here. */
export function killTerminal(terminalId: string): boolean {
  const terminal = terminals.get(terminalId);
  if (!terminal) return false;
  terminals.delete(terminalId);
  try {
    terminal.proc?.kill();
  } catch {
    /* already dead */
  }
  try {
    terminal.peer?.close(4000, "terminal closed");
  } catch {
    /* already gone */
  }
  return true;
}

/** Every terminal in a project — project deleted, or the server is going down. */
export function killProjectTerminals(projectId?: string): number {
  let killed = 0;
  for (const terminal of [...terminals.values()]) {
    if (projectId && terminal.projectId !== projectId) continue;
    if (killTerminal(terminal.id)) killed += 1;
  }
  return killed;
}

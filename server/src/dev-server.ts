/* ── Dev server ──
 *
 * One managed dev server per project: the process behind the preview.
 *
 * **Built on a terminal, not a bare spawn.** The dev command runs in a PTY
 * from `terminals.ts` (`role: "dev"`, `pinned` so the sweeper leaves it
 * alone), for three reasons that are each enough on their own: the user's
 * login shell finds `pnpm` the way their own terminal does; the output is
 * attachable through the terminal socket the client already speaks — "Logs"
 * is a panel, not a second stream; and a process the harness starts is one
 * the harness must be able to kill, which `killProjectTerminals` already does
 * on project delete and on shutdown. The install step is another terminal of
 * the same kind (`role: "install"`), run first when `node_modules` is missing.
 *
 * **The app is told where it lives.** `PORT` and `HOST` pin the bind;
 * `BASE_PATH` is the preview prefix (`preview-proxy.ts`), so the app's asset
 * URLs, router and API all sit under the path the proxy forwards unchanged.
 * `BROWSER=none` and `FORCE_COLOR=0` stop a template opening a tab on the
 * server and painting ANSI into the error parser.
 *
 * **Ready is measured, not announced.** Every dev server prints a different
 * banner; all of them answer HTTP. `starting` lasts until the base path
 * answers *any* status, polled every quarter second, and `START_TIMEOUT_MS`
 * without an answer is `failed` — a server that is not going to answer must
 * not leave the frame reloading a holding page forever.
 *
 * **Errors are read off the output.** A line that looks like one starts a
 * group, the lines that follow it in the same burst (the file, the code frame,
 * the stack) join it until two blank lines or a quiet gap, and the group lands in `errors` — capped, consecutive duplicates dropped, and
 * cleared on every (re)start so the panel never shows last run's failure
 * next to this run's preview. The browser-side errors come through the
 * bridge script and are the panel's to merge; this side sees only the
 * process.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { freePort } from "./net.js";
import { join } from "node:path";

import { getProject } from "./projects.js";
import type { DevError, DevStatus, DevTask, DevTaskKind } from "./protocol.js";
import { previewBase, setPreviewResolver, type PreviewTarget } from "./preview-proxy.js";
import { detectCommand, getTemplate } from "./templates.js";
import {
  createTerminal,
  killTerminal,
  onTerminalExit,
  tapTerminal,
  terminalScrollback,
} from "./terminals.js";
import { WorkspaceError, projectRoot } from "./workspace-fs.js";

/** How long the base path is polled before a start is called failed. */
const START_TIMEOUT_MS = 90_000;
/** How often the readiness poll asks. */
const POLL_MS = 250;
/** Errors kept per run. */
const MAX_ERRORS = 20;
/** A line that opens an error group. */
const ERROR_LINE = /\b(error|Error|ERR!|failed|Cannot find|SyntaxError|TypeError|ReferenceError)\b/;
/** An open group is closed after this much silence, so a one-line error
    shows up without waiting for the next unindented line. */
const GROUP_QUIET_MS = 400;
/** Lines one report may hold — enough for a frame and a stack, not a log. */
const MAX_GROUP_LINES = 40;

interface Managed {
  status: DevStatus;
  /** Bumped on every start/stop; a callback from an older run is ignored. */
  generation: number;
  /** Listeners on the terminals this run owns, all dropped on stop. */
  cleanups: Array<() => void>;
  /** Per terminal: close whatever error group is still open — called on exit,
      before the exit is reported, so the failure and its cause land together. */
  flushers: Map<string, () => void>;
  /** Route subscribers (`/dev/events`). Outlive a run. */
  subscribers: Set<(status: DevStatus) => void>;
}

const managed = new Map<string, Managed>();

const fail = (status: 400 | 404 | 409, message: string) => new WorkspaceError(message, status);

const blank = (projectId: string): DevStatus => ({
  projectId,
  state: "off",
  url: null,
  port: null,
  terminalId: null,
  installTerminalId: null,
  command: null,
  message: null,
  errors: [],
  since: Date.now(),
  readyAt: null,
  task: null,
});

function entry(projectId: string): Managed {
  let m = managed.get(projectId);
  if (!m) {
    m = { status: blank(projectId), generation: 0, cleanups: [], flushers: new Map(), subscribers: new Set() };
    managed.set(projectId, m);
  }
  return m;
}

/** A copy for readers, so nobody outside this file holds the live object. */
const snapshot = (status: DevStatus): DevStatus => ({ ...status, errors: [...status.errors] });

function emit(m: Managed, patch: Partial<DevStatus>): void {
  m.status = { ...m.status, ...patch, since: Date.now() };
  const copy = snapshot(m.status);
  for (const fn of m.subscribers) {
    try {
      fn(copy);
    } catch (error) {
      console.error("[dev-server] subscriber threw", error);
    }
  }
}

/** The status, for a project that exists — a 404 otherwise, like every other
    project-scoped read. */
export function devStatus(projectId: string): DevStatus {
  projectRoot(projectId);
  return snapshot(managed.get(projectId)?.status ?? blank(projectId));
}

/** Told the current status on every change. Returns the unsubscribe. */
export function subscribeDevStatus(projectId: string, fn: (status: DevStatus) => void): () => void {
  const m = entry(projectId);
  m.subscribers.add(fn);
  return () => {
    m.subscribers.delete(fn);
    if (m.subscribers.size === 0 && m.status.state === "off" && m.cleanups.length === 0) managed.delete(projectId);
  };
}

/* Handed to the proxy at load: what it asks is a subset of the status, and
   it asks on every request, so no copy is made. */
setPreviewResolver((projectId): PreviewTarget | null => {
  const m = managed.get(projectId);
  if (!m) return null;
  return { state: m.status.state, port: m.status.port, message: m.status.message };
});


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ── Error extraction ── */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g;

/** The last thing the process said — for `message` on a failure. */
function lastLine(terminalId: string): string {
  const lines = terminalScrollback(terminalId).replace(ANSI, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line.slice(0, 300);
  }
  return "";
}

/** Feed a terminal's chunks through the grouping rules and push what comes
    out onto the project's error list while `live()` holds. Returns the tap's
    unsubscribe and a flusher that closes whatever group is still open — the
    caller registers them where its lifetime is kept (the run's `cleanups`
    for the dev server, the exit handler for a task). */
function watchErrors(
  m: Managed,
  live: () => boolean,
  terminalId: string,
  source: DevError["source"] = "terminal",
): { untap: () => void; flush: () => void } {
  let partial = "";
  let group: string[] = [];
  let blanks = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (group.length === 0 || !live()) return;
    const text = group.join("\n").trim();
    group = [];
    blanks = 0;
    if (!text) return;
    const last = m.status.errors.at(-1);
    if (last && last.text === text) return;
    const error: DevError = { id: randomUUID(), at: Date.now(), source, text };
    const errors = [...m.status.errors, error].slice(-MAX_ERRORS);
    emit(m, { errors });
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, GROUP_QUIET_MS);
    timer.unref?.();
  };
  const line = (raw: string) => {
    const text = raw.replace(ANSI, "").replace(/\s+$/, "");
    /* An open group takes every line that follows it in the same burst: the
       file, the message, the code frame and the stack are printed one after
       another, most of them flush-left (Vite's transform errors, esbuild's
       `ERROR:` lines), so "indented means continuation" would keep only the
       headline. A blank line or a quiet gap is what ends a report. */
    if (group.length > 0) {
      if (!text.trim()) {
        /* One blank line is layout inside a report (Vite puts one after its
           headline and between the frame and the plugin lines); a run of them
           is the screen being cleared for the next message. */
        blanks += 1;
        if (blanks >= 2) flush();
        else if (group.length < MAX_GROUP_LINES) group.push("");
        return;
      }
      blanks = 0;
      if (group.length < MAX_GROUP_LINES) group.push(text);
      arm();
      return;
    }
    blanks = 0;
    if (ERROR_LINE.test(text)) {
      group.push(text.trim());
      arm();
    }
  };

  const untap = tapTerminal(terminalId, (chunk) => {
    partial += chunk;
    let at: number;
    while ((at = partial.indexOf("\n")) >= 0) {
      line(partial.slice(0, at));
      partial = partial.slice(at + 1);
    }
  });
  return {
    untap: () => {
      untap();
      if (timer) clearTimeout(timer);
    },
    flush: () => {
      // A last line with no newline is still a line once the process is gone.
      if (partial.trim()) line(partial);
      partial = "";
      flush();
    },
  };
}

/** `watchErrors` for one of the run's own terminals: registered on the run,
    dropped by `teardown`. */
function watchRun(m: Managed, generation: number, terminalId: string): void {
  const watch = watchErrors(m, () => m.generation === generation, terminalId);
  m.cleanups.push(watch.untap);
  m.flushers.set(terminalId, watch.flush);
}

/* ── Lifecycle ── */

export interface StartOptions {
  /** The install command to run first when `node_modules` is missing. `null`
      for none; absent means "the template's, if the project has one". */
  install?: string | null;
}

/**
 * Start the project's dev server, or hand back the one already running.
 *
 * Idempotent: the panel calls this on mount, the scaffold route calls it once
 * and forgets, and neither may end up with two servers on one directory. It
 * returns as soon as the run is *underway* — `installing` or `starting` — and
 * the rest arrives through `subscribeDevStatus`.
 */
export async function startDevServer(projectId: string, options: StartOptions = {}): Promise<DevStatus> {
  const cwd = projectRoot(projectId);
  const project = getProject(projectId)!;
  const m = entry(projectId);
  if (m.status.state === "installing" || m.status.state === "starting" || m.status.state === "ready")
    return snapshot(m.status);

  const command = project.devCommand?.trim();
  if (!command) throw fail(409, "this project has no dev command");

  // A previous run's terminals (an `exited` server still showing its log) go
  // before the new one starts, so the project's terminal cap is not spent on
  // corpses.
  teardown(m);
  const generation = ++m.generation;
  /* A running build/check is its own terminal and its own generation-free
     lifecycle; a (re)start of the server neither kills it nor forgets it. */
  emit(m, { ...blank(projectId), command, since: Date.now(), task: m.status.task });

  /* The template's install when it has one; else what the directory says
     (`daedalus.json`, or `<pm> install` beside a package.json) — a
     from-scratch build and a plain project with a dev command are both
     projects the agent, not a starter, gave dependencies to. */
  const install =
    options.install === undefined
      ? (project.templateId && getTemplate(project.templateId)?.install) || detectCommand(cwd, "install")
      : options.install;

  if (install && !existsSync(join(cwd, "node_modules"))) {
    let terminal;
    try {
      terminal = createTerminal(projectId, {
        command: install,
        role: "install",
        pinned: true,
        title: "Install",
        env: { CI: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      emit(m, { state: "failed", message: error instanceof Error ? error.message : String(error) });
      return snapshot(m.status);
    }
    emit(m, { state: "installing", installTerminalId: terminal.id });
    watchRun(m, generation, terminal.id);
    m.cleanups.push(
      onTerminalExit(terminal.id, (code) => {
        if (m.generation !== generation) return;
        m.flushers.get(terminal.id)?.();
        if (code !== 0) {
          emit(m, {
            state: "failed",
            message: `${install} exited with code ${code}${lastLine(terminal.id) ? `: ${lastLine(terminal.id)}` : ""}`,
          });
          return;
        }
        void spawnDev(m, generation, projectId, command);
      }),
    );
    return snapshot(m.status);
  }

  await spawnDev(m, generation, projectId, command);
  return snapshot(m.status);
}

async function spawnDev(m: Managed, generation: number, projectId: string, command: string): Promise<void> {
  let port: number;
  try {
    port = await freePort();
  } catch (error) {
    emit(m, { state: "failed", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (m.generation !== generation) return;
  const base = previewBase(projectId);

  let terminal;
  try {
    terminal = createTerminal(projectId, {
      command,
      role: "dev",
      pinned: true,
      title: "Dev server",
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        BASE_PATH: base,
        BROWSER: "none",
        FORCE_COLOR: "0",
        DAEDALUS_PREVIEW: "1",
      },
    });
  } catch (error) {
    emit(m, { state: "failed", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  emit(m, { state: "starting", url: base, port, terminalId: terminal.id, message: null });
  watchRun(m, generation, terminal.id);
  m.cleanups.push(
    onTerminalExit(terminal.id, (code) => {
      if (m.generation !== generation) return;
      m.flushers.get(terminal.id)?.();
      const wasReady = m.status.state === "ready";
      const tail = lastLine(terminal.id);
      emit(m, {
        state: wasReady || code === 0 ? "exited" : "failed",
        url: null,
        port: null,
        readyAt: null,
        message: `${command} exited with code ${code}${tail ? `: ${tail}` : ""}`,
      });
    }),
  );

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (m.generation !== generation || m.status.state !== "starting") return;
    if (await answers(port, base)) {
      if (m.generation !== generation || m.status.state !== "starting") return;
      emit(m, { state: "ready", readyAt: Date.now() });
      return;
    }
    await sleep(POLL_MS);
  }
  if (m.generation !== generation || m.status.state !== "starting") return;
  killTerminal(terminal.id);
  emit(m, {
    state: "failed",
    url: null,
    port: null,
    message: `${command} did not answer on port ${port} within ${START_TIMEOUT_MS / 1000}s.`,
  });
}

/** Any HTTP status counts — a 404 from a router that has not learned the base
    path yet is still a server that is up. */
async function answers(port: number, base: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${base}`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** Drop this run's listeners and kill its terminals. The status is the
    caller's to set. */
function teardown(m: Managed): void {
  for (const off of m.cleanups.splice(0)) off();
  m.flushers.clear();
  if (m.status.terminalId) killTerminal(m.status.terminalId);
  if (m.status.installTerminalId) killTerminal(m.status.installTerminalId);
}

/** Stop the project's dev server. Returns the resulting status; a project
    with none is simply `off`. */
export function stopDevServer(projectId: string): DevStatus {
  const m = managed.get(projectId);
  if (!m) return blank(projectId);
  m.generation += 1;
  teardown(m);
  emit(m, { ...blank(projectId), errors: m.status.errors, command: m.status.command, task: m.status.task });
  return snapshot(m.status);
}

/** Stop, then start — errors cleared by the start. */
export async function restartDevServer(projectId: string, options: StartOptions = {}): Promise<DevStatus> {
  projectRoot(projectId);
  stopDevServer(projectId);
  return startDevServer(projectId, options);
}


/* ── Build and check tasks ──
   The project's own scripts, run on demand in a terminal of their own
   (`role: "build"`), one at a time per project. The output is read through
   the same error grouping as the dev server's, tagged with the task's kind,
   so a failing typecheck lands in the panel's strip next to the runtime
   errors and takes the same "Fix" button. The terminal is left alive after
   the exit so "Logs" can still show it; the next task kills it. */

/**
 * The command for a task: the template's, when the project has one and the
 * manifest names it; else the directory's own answer (`templates.ts ›
 * detectCommand`: `daedalus.json`, then `<pm> run <script>` when
 * `package.json` declares the script); else null.
 */
export function taskCommand(projectId: string, kind: DevTaskKind): string | null {
  const cwd = projectRoot(projectId);
  const project = getProject(projectId)!;
  if (project.templateId) {
    const template = getTemplate(project.templateId);
    const own = template?.[kind];
    if (own) return own;
  }
  return detectCommand(cwd, kind);
}

/** Run the project's build or check script. Answers as soon as it is
    running; the result arrives on the stream as `task`. A task already
    running is a 409 — two typechecks racing in one tree help nobody. */
export function runDevTask(projectId: string, kind: DevTaskKind): DevStatus {
  projectRoot(projectId);
  const m = entry(projectId);
  if (m.status.task?.state === "running") throw fail(409, `a ${m.status.task.kind} is already running`);
  const command = taskCommand(projectId, kind);
  if (!command) throw fail(409, `this project has no ${kind} script`);

  if (m.status.task) killTerminal(m.status.task.terminalId);
  const errors = m.status.errors.filter((e) => e.source !== kind);

  const terminal = createTerminal(projectId, {
    command,
    role: "build",
    pinned: true,
    title: kind === "build" ? "Build" : "Check",
    env: { CI: "1", FORCE_COLOR: "0", NODE_ENV: kind === "build" ? "production" : "development" },
  });
  const task: DevTask = {
    kind,
    state: "running",
    command,
    terminalId: terminal.id,
    message: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  emit(m, { task, errors });
  /* Live for as long as this terminal is the status's task — not tied to the
     run generation, which a dev-server restart bumps mid-typecheck. */
  const watch = watchErrors(m, () => m.status.task?.terminalId === terminal.id, terminal.id, kind);
  const off = onTerminalExit(terminal.id, (code) => {
    off();
    watch.flush();
    watch.untap();
    if (m.status.task?.terminalId !== terminal.id) return;
    const tail = code === 0 ? "" : lastLine(terminal.id);
    emit(m, {
      task: {
        ...m.status.task,
        state: code === 0 ? "passed" : "failed",
        message: code === 0 ? null : `${command} exited with code ${code}${tail ? `: ${tail}` : ""}`,
        endedAt: Date.now(),
      },
    });
  });
  return snapshot(m.status);
}

/** Forget a project entirely — its row is gone. The terminals are the
    caller's (`killProjectTerminals`); this clears what would otherwise answer
    the proxy for a project that no longer exists. */
export function forgetDevServer(projectId: string): void {
  const m = managed.get(projectId);
  if (!m) return;
  m.generation += 1;
  if (m.status.task?.terminalId) killTerminal(m.status.task.terminalId);
  for (const off of m.cleanups.splice(0)) off();
  m.flushers.clear();
  managed.delete(projectId);
}

/** Every dev server, on shutdown. Terminals are killed by
    `killProjectTerminals()` beside this; this drops the state so nothing
    answers a late request as though a server were still up. */
export function stopAllDevServers(): void {
  for (const projectId of [...managed.keys()]) {
    const m = managed.get(projectId)!;
    m.generation += 1;
    teardown(m);
    if (m.status.task?.terminalId) killTerminal(m.status.task.terminalId);
    managed.delete(projectId);
  }
}

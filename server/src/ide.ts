/* ── Embedded IDE ──
 *
 * A real VS Code — `code-server` — per project, spawned by this process and
 * reached only through this process.
 *
 * **Why a child process and not an iframe pointed at localhost.** The panel is
 * a page in a browser that may be nowhere near the machine the code is on: the
 * phone on the sofa, the tunnel from `dev:tunnel`. `http://localhost:8080` on
 * that device is that device. The only address the browser can be given is the
 * harness's own, which means the harness has to own the process and carry the
 * traffic — the same bargain `terminals.ts` already makes for a PTY.
 *
 * **Loopback plus a path capability, not `--auth`.** code-server is bound to
 * `127.0.0.1` on an ephemeral port and started with `--auth none`, so nothing
 * off this machine can reach it directly. What reaches it is `/ide/<key>/…`,
 * where `key` is 24 random bytes minted per instance and handed out only by an
 * authenticated API call. That shape is not decoration: an iframe cannot set an
 * `Authorization` header, and every asset, font and WebSocket code-server asks
 * for afterwards is a *relative* URL — so the credential has to be somewhere
 * the browser will repeat on its own. A cookie is the other candidate and it is
 * worse here: the client's page and the harness are different origins (the app
 * is served by Vite, or from a tunnel, while the server is elsewhere), so the
 * cookie would have to be `SameSite=None; Secure`, which plain-http localhost
 * refuses. A prefix is repeated by the browser for free, over either scheme.
 * The key lives only in memory and dies with the instance.
 *
 * **Killing is explicit, idling is swept.** Closing the panel does not stop the
 * editor — an unsaved buffer, a running task and an extension host are exactly
 * the state you close a laptop lid on. Traffic through the proxy is the
 * liveness signal; `IDLE_MS` without any is what reclaims it.
 *
 * Everything is bounded: instances at once, how long one lives unused, and how
 * long a start is waited on before it is called failed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./config.js";
import { WorkspaceError, projectRoot } from "./workspace-fs.js";

/** Editors running at once. Each is a full VS Code — an extension host, a file
    watcher and a language server or three — so this is a memory ceiling. */
const MAX_INSTANCES = 4;
/** No proxy traffic for this long and the editor is reclaimed. */
const IDLE_MS = 4 * 60 * 60 * 1000;
/** How long `/healthz` is waited on before a start is called failed. */
const START_TIMEOUT_MS = 90_000;
/** How often the start poll asks. */
const POLL_MS = 250;
/** How often the sweeper looks for idle instances. */
const SWEEP_MS = 60 * 1000;
/** Stderr kept for the failure message. */
const STDERR_TAIL = 4000;

/** Candidate binaries, in the order they are tried. `openvscode-server` speaks
    the same HTTP shape from a proxy's point of view, so it works here too. */
const BINARIES = ["code-server", "openvscode-server"] as const;

export type IdeState = "off" | "starting" | "ready" | "failed" | "unavailable";

export interface IdeStatus {
  projectId: string;
  state: IdeState;
  /** The prefix to frame, `/ide/<key>/`. Only set while `ready`. */
  path: string | null;
  /** Why it is not usable — the spawn error, the stderr tail, the install hint. */
  message: string | null;
  /** The binary this install would run, or null when there is none. */
  binary: string | null;
  /** What to run to get one. Only set when `unavailable`. */
  install: string | null;
}

interface Ide {
  projectId: string;
  key: string;
  port: number;
  /** Null for an editor this process adopted rather than spawned — it is a
      live process either way, but only a child can be listened to. */
  proc: ChildProcess | null;
  pid: number | undefined;
  binary: string;
  state: Exclude<IdeState, "off" | "unavailable">;
  message: string | null;
  stderr: string;
  lastActivity: number;
}

const instances = new Map<string, Ide>();
/** key → projectId, so the proxy resolves a path prefix without a scan. */
const byKey = new Map<string, string>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const fail = (status: 400 | 403 | 404 | 409, message: string) =>
  new WorkspaceError(message, status);

const INSTALL_HINT = "curl -fsSL https://code-server.dev/install.sh | sh";

/* A PATH lookup is a spawn, and the panel asks on every mount, so the answer is
   cached — but **only the positive one**. A binary that is there stays there,
   and finding it again would cost a `--version` per panel open for nothing. A
   binary that is *missing* is the state the user is about to change: the panel
   says "install it and press Check again", and a permanent negative cache makes
   that button a lie until the server is restarted. So a miss expires. */
const MISS_TTL_MS = 15_000;
let resolvedBinary: string | null = null;
let lastProbe = 0;

function findBinary(): string | null {
  if (resolvedBinary) return resolvedBinary;
  if (lastProbe && Date.now() - lastProbe < MISS_TTL_MS) return null;
  lastProbe = Date.now();
  for (const candidate of BINARIES) {
    /* `--version` rather than `which`: it is the same one lookup the spawn
       will do, through the same PATH, and it also catches a binary that is
       present but not executable. */
    if (spawnSyncQuiet(candidate)) {
      resolvedBinary = candidate;
      break;
    }
  }
  return resolvedBinary;
}

function spawnSyncQuiet(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 15_000 });
  return !result.error && result.status === 0;
}

/** An unused loopback port. Bound and released rather than guessed — the window
    between the release and code-server's own bind is small enough that a
    collision is a failed start the user can retry, and picking a number out of
    a range collides far more often than that. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/* ── Surviving a restart ──
 *
 * The instance table is memory; the editor is a process. A clean shutdown takes
 * both, but the signal often does not arrive — pm2 runs `d-server` as `bash -c
 * pnpm dev`, so SIGINT lands on the wrapper and `stopAllIdes` never runs — and
 * a `SIGKILL` or a crash never gives one at all. Either way a live code-server
 * is left holding this project's `--user-data-dir`.
 *
 * **The first instinct was to kill it, and that was wrong.** This whole module
 * argues that closing the panel must not cost you an unsaved buffer or a
 * running task; killing the editor on every server restart says the opposite,
 * and in dev — where `tsx watch` restarts on every keystroke in this file —
 * it would say it constantly. So a restart **adopts**: the key is written down
 * beside the pid, and a new process that finds a live, healthy editor takes it
 * back under the *same* key, which is what open browser frames are still using.
 * The restart becomes invisible instead of destructive. Killing is the fallback
 * for an editor that is there but not answering.
 *
 * The pid alone is never enough to act on: pids are reused, and signalling a
 * number that now means something else is a far worse bug than the one being
 * fixed. It is trusted only where it can be *verified* — on Linux, by reading
 * the recorded process's own command line back and requiring this project's
 * data directory in it. Anywhere else a stale record is dropped without a
 * signal, which risks a second editor rather than a wrong kill.
 */
const LOCK = ".daedalus-ide.json";

interface Lock {
  pid?: number;
  port?: number;
  key?: string;
}

/** The recorded process, if it is still alive and still that process. */
function verifyPid(pid: number | undefined, userDataDir: string): boolean {
  if (!pid || pid === process.pid) return false;
  if (process.platform !== "linux") return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(userDataDir);
  } catch {
    return false; // Already gone.
  }
}

function readLock(userDataDir: string): Lock | null {
  try {
    return JSON.parse(readFileSync(join(userDataDir, LOCK), "utf8")) as Lock;
  } catch {
    return null;
  }
}

/**
 * Take back, or clean up, the editors left by a previous process — at boot,
 * before anything is served.
 *
 * Awaited rather than fired off, so the first request cannot arrive between the
 * health check and the registration and be told the editor is off.
 */
export async function adoptOrphans(): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(join(DATA_DIR, "ide"));
  } catch {
    return; // No editor has ever run here.
  }
  for (const entry of entries) {
    if (entry === "extensions") continue;
    const userDataDir = join(DATA_DIR, "ide", entry);
    const lock = readLock(userDataDir);
    if (!lock) continue;
    if (!verifyPid(lock.pid, userDataDir)) {
      rmSync(join(userDataDir, LOCK), { force: true });
      continue;
    }
    /* Alive, and it is ours. Answering is the last question: an editor that is
       running but wedged is worse than none, because the panel would frame it
       and wait forever rather than offering to start one that works. */
    if (lock.port && lock.key && (await healthy(lock.port))) {
      const ide: Ide = {
        projectId: entry,
        key: lock.key,
        port: lock.port,
        proc: null,
        pid: lock.pid,
        binary: findBinary() ?? "code-server",
        state: "ready",
        message: null,
        stderr: "",
        lastActivity: Date.now(),
      };
      instances.set(entry, ide);
      byKey.set(lock.key, entry);
      startSweeper();
      continue;
    }
    killPid(lock.pid);
    rmSync(join(userDataDir, LOCK), { force: true });
  }
}

function killPid(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* It exited between the check and the signal — the outcome wanted. */
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Gone, as intended. */
    }
  }, 5000).unref?.();
}

function writeLock(userDataDir: string, ide: Ide) {
  try {
    writeFileSync(
      join(userDataDir, LOCK),
      // The key is the part that makes adoption work: a frame already open is
      // using it, and a restart that minted a new one would strand that frame.
      JSON.stringify({ pid: ide.pid, port: ide.port, key: ide.key, at: Date.now() }),
    );
  } catch {
    /* Losing the record costs a possible orphan after a crash, which is not
       worth failing a start the user asked for. */
  }
}

function statusOf(projectId: string, ide: Ide | undefined): IdeStatus {
  const binary = findBinary();
  if (!ide) {
    return {
      projectId,
      state: binary ? "off" : "unavailable",
      path: null,
      message: binary
        ? null
        : `Neither ${BINARIES.join(" nor ")} is on this server's PATH.`,
      binary,
      install: binary ? null : INSTALL_HINT,
    };
  }
  return {
    projectId,
    state: ide.state,
    path: ide.state === "ready" ? `/ide/${ide.key}/` : null,
    message: ide.message,
    binary: ide.binary,
    install: null,
  };
}

/* ── Theme ──
   The editor follows the app's palette. VS Code has no API for that from
   outside, but it has two settings that together amount to one:
   `workbench.colorTheme` picks the base (light or dark — the syntax colours
   come from there) and `workbench.colorCustomizations` paints the chrome over
   it, key by key, in plain hex. Both live in the editor's *user* settings —
   `data/ide/<project>/User/settings.json`, ours to write since the harness
   owns the user-data dir — and VS Code watches that file, so a write lands
   in the open workbench without a reload. The map is computed in the browser
   (it is the only place the palette's CSS resolves) and only merged here: the
   user's other settings in that file are theirs and are left as they were. */

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

export const IdeThemeSchema = z.object({
  colorTheme: z.string().min(1).max(100),
  colorCustomizations: z
    .record(z.string().min(1).max(100), z.string().regex(HEX))
    .refine((map) => Object.keys(map).length <= 200, "too many colours"),
});
export type IdeTheme = z.infer<typeof IdeThemeSchema>;

const THEME_KEYS = ["workbench.colorTheme", "workbench.colorCustomizations"] as const;

/** Write the palette into the editor's user settings, keeping everything else. */
export function applyIdeTheme(projectId: string, theme: IdeTheme): void {
  projectRoot(projectId);
  const userDir = join(DATA_DIR, "ide", projectId, "User");
  const file = join(userDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        settings = parsed as Record<string, unknown>;
    } catch {
      /* VS Code's settings file may carry comments or trailing commas, which
         it tolerates and JSON.parse does not. Rewriting it from a failed parse
         would throw the user's settings away for a colour, so the theme
         yields instead. */
      throw fail(409, "The editor's settings.json isn't plain JSON, so the theme wasn't applied.");
    }
  }
  if (
    settings[THEME_KEYS[0]] === theme.colorTheme &&
    JSON.stringify(settings[THEME_KEYS[1]]) === JSON.stringify(theme.colorCustomizations)
  )
    return;
  settings[THEME_KEYS[0]] = theme.colorTheme;
  settings[THEME_KEYS[1]] = theme.colorCustomizations;
  mkdirSync(userDir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 4) + "\n");
}

export function ideStatus(projectId: string): IdeStatus {
  projectRoot(projectId);
  return statusOf(projectId, instances.get(projectId));
}

/**
 * Start the editor for a project, or hand back the one already running.
 *
 * Idempotent by design: the panel calls this on every mount, and a remount
 * (a theme change, a tab drag) must not spawn a second VS Code on the same
 * directory — two extension hosts writing one `.vscode` is a corruption, not a
 * race. It returns as soon as the process is up and `/healthz` answers, so a
 * `ready` status means the iframe has something to load.
 */
export async function startIde(projectId: string, theme?: IdeTheme): Promise<IdeStatus> {
  const cwd = projectRoot(projectId);
  /* Before the spawn, so the first paint is already in the palette; and for a
     running editor too, since the file is watched. */
  if (theme) applyIdeTheme(projectId, theme);

  const existing = instances.get(projectId);
  if (existing && existing.state !== "failed") return statusOf(projectId, existing);
  if (existing) retire(existing);

  const binary = findBinary();
  if (!binary) return statusOf(projectId, undefined);

  if (instances.size >= MAX_INSTANCES)
    throw fail(
      409,
      `${MAX_INSTANCES} editors are already running. Close one before opening another.`,
    );

  const port = await freePort();
  const key = randomBytes(24).toString("base64url");
  const userDataDir = join(DATA_DIR, "ide", projectId);
  const extensionsDir = join(DATA_DIR, "ide", "extensions");
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  /* Nothing to adopt here: `adoptOrphans` ran at boot, so a live editor for
     this project would already be in `instances` and returned above. A lock
     still on disk names a process that failed that check. */
  const stale = readLock(userDataDir);
  if (stale && verifyPid(stale.pid, userDataDir)) killPid(stale.pid);

  /* `--auth none` is safe only because of the bind address on the line above
     it; the two belong together and neither is optional. The telemetry and
     update flags are there because this is not the user's own install of
     code-server — it is a process the harness starts on their behalf, and it
     should not phone anywhere they did not ask it to. */
  const args = [
    "--auth",
    "none",
    "--bind-addr",
    `127.0.0.1:${port}`,
    /* `--bind-addr` is not the last word: code-server's `bindAddrFromArgs`
       lets `PORT` and `CODE_SERVER_HOST` in the environment override it, and
       only the explicit `--host`/`--port` flags beat the environment. The
       harness inherits its env into the child, and `PORT` is one of the
       names `loadConfig` accepts for the harness's *own* port — so an install
       started with `PORT=4001` had every editor try to bind 4001 and fail
       with EADDRINUSE against the process that spawned it. */
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    cwd,
  ];

  /* Belt and braces with the flags above: the env code-server sees carries
     none of the names it reads a bind address from. */
  const env = { ...process.env };
  delete env.PORT;
  delete env.CODE_SERVER_HOST;
  const proc = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

  const ide: Ide = {
    projectId,
    key,
    port,
    proc,
    pid: proc.pid,
    binary,
    state: "starting",
    message: null,
    stderr: "",
    lastActivity: Date.now(),
  };
  instances.set(projectId, ide);
  byKey.set(key, projectId);
  writeLock(userDataDir, ide);
  startSweeper();

  proc.stdout?.on("data", () => {
    /* Drained, not read. code-server is chatty and the readiness answer comes
       from `/healthz`, not from a log line whose wording is a version detail —
       but an unread pipe fills, and a full pipe blocks the editor. */
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    ide.stderr = (ide.stderr + chunk.toString()).slice(-STDERR_TAIL);
  });
  proc.on("error", (error) => {
    ide.state = "failed";
    ide.message = error.message;
  });
  proc.on("exit", (code, signal) => {
    if (ide.state === "ready" || ide.state === "starting") {
      ide.state = "failed";
      ide.message =
        ide.stderr.trim() ||
        `${binary} exited ${signal ? `on ${signal}` : `with code ${code}`}.`;
    }
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ide.state === "failed") return statusOf(projectId, ide);
    if (await healthy(port)) {
      ide.state = "ready";
      ide.lastActivity = Date.now();
      return statusOf(projectId, ide);
    }
    await sleep(POLL_MS);
  }

  ide.state = "failed";
  ide.message = ide.stderr.trim() || `${binary} did not answer within ${START_TIMEOUT_MS / 1000}s.`;
  retire(ide);
  return statusOf(projectId, ide);
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    /* Still binding, or already gone — the caller's loop decides which by
       whether the process is still alive. */
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where a `/ide/<key>/…` request goes, and null when that key means nothing.
    Touching `lastActivity` here is what keeps a watched editor from being swept
    out from under the person watching it. */
export function ideTarget(key: string): { port: number; projectId: string } | null {
  const projectId = byKey.get(key);
  const ide = projectId ? instances.get(projectId) : undefined;
  if (!ide || ide.state !== "ready") return null;
  ide.lastActivity = Date.now();
  return { port: ide.port, projectId: ide.projectId };
}

function retire(ide: Ide) {
  instances.delete(ide.projectId);
  byKey.delete(ide.key);
  rmSync(join(DATA_DIR, "ide", ide.projectId, LOCK), { force: true });
  /* SIGTERM, not SIGKILL: VS Code flushes its state database and its unsaved
     buffer backups on the way out, and those backups are the whole reason an
     editor that was killed can be reopened without losing work. An adopted
     editor has no ChildProcess to ask, only a pid — same signal, same grace. */
  if (ide.proc) {
    const proc = ide.proc;
    proc.kill("SIGTERM");
    setTimeout(() => proc.killed || proc.kill("SIGKILL"), 5000).unref?.();
  } else {
    killPid(ide.pid);
  }
}

/** Stop the editor for one project. Returns false when there was none. */
export function stopIde(projectId: string): boolean {
  const ide = instances.get(projectId);
  if (!ide) return false;
  retire(ide);
  return true;
}

/**
 * Every editor, on shutdown.
 *
 * The asymmetry with `adoptOrphans` is deliberate, not an oversight: a process
 * that is *told* to stop stops what it owns, because leaving four VS Codes
 * running behind a server nobody is going to restart is a leak. A process that
 * dies without being told — a crash, or a signal that never got past the shell
 * wrapper pm2 launches — cannot clean up, and the next one adopts instead. So
 * the destructive path is the one someone asked for.
 */
export function stopAllIdes(): void {
  for (const ide of [...instances.values()]) retire(ide);
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const ide of [...instances.values()]) {
      if (ide.state === "failed" || now - ide.lastActivity > IDLE_MS) retire(ide);
    }
    if (instances.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, SWEEP_MS);
  sweeper.unref?.();
}

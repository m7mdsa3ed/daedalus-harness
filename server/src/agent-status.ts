import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import * as acp from "./acp.js";
import { withAgentConnection } from "./probe.js";
import { defaultProfileFor } from "./profiles.js";
import type { Project } from "./projects.js";
import { getAgent, resolveSpawn, type AgentDef } from "./registry.js";

/*
 * Is this agent installed, and what is on the other end of the pipe.
 *
 * Two questions the registry cannot answer on its own. A row is a *contract*
 * with a binary somebody else ships — `claude-agent-acp` on PATH, a built
 * `agent/dist/index.js` — and until now the first place a missing one showed
 * was an ENOENT inside a thread that had just been asked to do something. The
 * settings page that lists the row should be the place that says so, with the
 * command that fixes it.
 *
 * The second half is the version. It is read the way everything else about a
 * runtime is read here — over ACP, not off a `--version` flag whose format
 * every CLI invents for itself: the `initialize` answer carries the negotiated
 * `protocolVersion` and (since ACP 0.4) an `agentInfo {name, version}`, and
 * all four runtimes we ship fill it in. One handshake, one shape, no parsing.
 *
 * Both answers are facts about *this machine right now*, so they are cached
 * in memory with a short TTL and never in the database — the next boot may be
 * on a host where the binary was upgraded or removed. An edit to the row's
 * command evicts (`evictAgentStatus`), and `?refresh=1` is the way past the
 * TTL for the case the key cannot see: an `npm install -g` that just ran.
 */

export interface AgentStatus {
  agentId: string;
  /** The row's command, as the spawn would run it. */
  command: string;
  installed: boolean;
  /** Where the command was found, when it was. */
  path: string | null;
  /** What could not be found — the command itself, or a file the args name. */
  missing: string | null;
  /** How to put it there, for the built-ins whose package we know. */
  install: string | null;
  /** The ACP protocol version the agent answered `initialize` with. */
  protocolVersion: number | null;
  /** The agent's own name and version, as it reports them over ACP. */
  agent: { name: string; title: string | null; version: string | null } | null;
  /** Why the handshake did not answer, when the binary was there but the
      version is not: a crash on boot, a timeout, a missing dependency. */
  error: string | null;
  /** The newest published version, when the install line names an npm package
      — the only kind of "latest" the harness can ask about without knowing a
      vendor. Null for a curl script, a local build, or an unreachable
      registry: not knowing is an answer, never a failure. */
  latest: string | null;
  checkedAt: number;
}

export interface AgentsStatus {
  /** The harness's half of the protocol: the SDK it speaks through and the
      version it asks for on every handshake. */
  acp: { sdkVersion: string; protocolVersion: number };
  agents: AgentStatus[];
}

/* The install line is the row's (`AgentDef.install`, seeded per built-in and
   editable). It used to be a table here keyed by agent id — the last fact
   about a runtime living outside the registry, and one an agent somebody added
   could never carry: a row measured as missing showed no way to fix it. */

/* Read off the server's own manifest, where the version is pinned exactly
   (CLAUDE.md, "The ACP SDK is named in one file per half"). The SDK's own
   package.json is not exported by the package, so this is the one place the
   number can be read from at runtime. `../package.json` resolves the same from
   `src/` (tsx) and `dist/` (built), both one level under server/. */
const SDK_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["@agentclientprotocol/sdk"] ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export const acpVersions = () => ({ sdkVersion: SDK_VERSION, protocolVersion: acp.PROTOCOL_VERSION });

// ---------------------------------------------------------------------------
// Where is the binary
// ---------------------------------------------------------------------------

/** A regular file that may be run — what PATH lookup wants. */
const isExecutable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** A regular file, executable or not — what an *argument* wants: the script
    behind `node <entry>` is read by node, and never carries the execute bit. */
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolve a command the way `spawn` will: a name is looked up on PATH (with
 * PATHEXT on Windows), anything with a separator in it is a path relative to
 * the cwd. Pure — PATH and cwd are arguments — so the registry test can drive
 * it without a real filesystem layout.
 */
export function locateCommand(
  command: string,
  { path = process.env.PATH ?? "", cwd = process.cwd(), exts = pathExts() } = {},
): string | null {
  const candidates = (base: string) => (exts.length ? [base, ...exts.map((e) => base + e)] : [base]);
  if (command.includes("/") || command.includes("\\")) {
    const abs = isAbsolute(command) ? command : resolve(cwd, command);
    return candidates(abs).find(isExecutable) ?? null;
  }
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const hit = candidates(join(dir, command)).find(isExecutable);
    if (hit) return hit;
  }
  return null;
}

function pathExts(): string[] {
  if (process.platform !== "win32") return [];
  return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
}

/**
 * The install check, without a process. The command must be on PATH, and any
 * argument that is an absolute path must exist — which is how the harness's
 * own agent (`node <repo>/agent/dist/index.js`) reports an unbuilt `dist` as
 * "not installed" rather than as `node` being present, which it always is.
 */
export function checkInstalled(agent: AgentDef, project: Project): Pick<AgentStatus, "installed" | "path" | "missing"> {
  const spawn = resolveSpawn(agent, defaultProfileFor(agent.id, agent.name), project);
  const path = locateCommand(spawn.command, { cwd: project.cwd });
  if (!path) return { installed: false, path: null, missing: spawn.command };
  for (const arg of spawn.args) {
    if (isAbsolute(arg) && !isFile(arg)) return { installed: false, path, missing: arg };
  }
  return { installed: true, path, missing: null };
}

// ---------------------------------------------------------------------------
// What is published
// ---------------------------------------------------------------------------

/*
 * "Is there a newer one" is only askable where the install line names a
 * registry the harness already knows how to read — `npm install -g <pkg>`.
 * Anything else (opencode's curl script, our own `pnpm --dir agent build`)
 * answers null, exactly like a registry that did not respond. The package
 * comes off the row's own install line, so nothing here spells a vendor's
 * package name: repoint the line and the check follows it.
 */
const NPM_INSTALL = /\bnpm\s+(?:i|install|add)\b[^|&;]*/;

export function npmPackage(install: string | null | undefined): string | null {
  const line = install?.match(NPM_INSTALL)?.[0];
  if (!line) return null;
  const word = line
    .split(/\s+/)
    .slice(2)
    .find((w) => w && !w.startsWith("-"));
  if (!word) return null;
  // Drop a version/tag suffix: `pkg@1.2.3`, `@scope/pkg@latest`.
  const at = word.lastIndexOf("@");
  return at > 0 ? word.slice(0, at) : word;
}

/** Published versions move far more slowly than a binary on this box, and the
    read costs a network round trip, so it gets its own longer TTL. */
const LATEST_TTL_MS = 60 * 60_000;
const latestCache = new Map<string, { version: string | null; at: number }>();

async function latestVersion(pkg: string, refresh: boolean): Promise<string | null> {
  const hit = latestCache.get(pkg);
  if (!refresh && hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  let version: string | null = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.split("/").map(encodeURIComponent).join("/")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) version = ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    version = null;
  }
  latestCache.set(pkg, { version, at: Date.now() });
  return version;
}

const latestFor = (agent: AgentDef, refresh: boolean): Promise<string | null> => {
  const pkg = npmPackage(agent.install);
  return pkg ? latestVersion(pkg, refresh) : Promise.resolve(null);
};

// ---------------------------------------------------------------------------
// Putting it there
// ---------------------------------------------------------------------------

/**
 * Run the row's own install line. It is the same string the page already
 * offered to copy — the only new thing is who types it — so there is nothing
 * to validate and nothing to build: no package name is composed here, and an
 * agent whose row carries no install line simply cannot be installed.
 * Non-interactive by nature (`npm install -g`, a curl script, a local build),
 * which is why this is not a terminal panel.
 */
export async function installAgent(agent: AgentDef): Promise<{ ok: boolean; output: string }> {
  if (!agent.install) return { ok: false, output: "This agent has no install command." };
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run(agent.install, {
      shell: true,
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || (e.message ?? "install failed") };
  } finally {
    evictAgentStatus(agent.id);
  }
}

// ---------------------------------------------------------------------------
// What answers
// ---------------------------------------------------------------------------

/** Long enough for an upgrade to show up on its own; short enough that the
    settings page is not told about a binary removed an hour ago. */
export const STATUS_TTL_MS = 5 * 60_000;

const cache = new Map<string, AgentStatus>();
const inflight = new Map<string, Promise<AgentStatus>>();

/** The row's command changed — whatever was measured was measured on the old
    one. Called by the update and reset routes. */
export function evictAgentStatus(agentId: string): void {
  cache.delete(agentId);
}

/** The cwd the handshake runs in. An agent's version is the same in every
    directory, so the server's own is fine, and requiring a project would make
    the settings page depend on there being one. */
const statusProject = (): Project => ({ id: "", name: "", cwd: process.cwd(), description: null });

export function getAgentStatus(agent: AgentDef, { refresh = false } = {}): Promise<AgentStatus> {
  if (!refresh) {
    const hit = cache.get(agent.id);
    if (hit && Date.now() - hit.checkedAt < STATUS_TTL_MS) return Promise.resolve(hit);
  }
  const running = inflight.get(agent.id);
  if (running) return running;
  const run = measure(agent, refresh)
    .then((status) => {
      cache.set(agent.id, status);
      return status;
    })
    .finally(() => inflight.delete(agent.id));
  inflight.set(agent.id, run);
  return run;
}

export async function getAgentsStatus(agents: AgentDef[], opts: { refresh?: boolean } = {}): Promise<AgentsStatus> {
  return {
    acp: acpVersions(),
    agents: await Promise.all(agents.map((agent) => getAgentStatus(agent, opts))),
  };
}

async function measure(agent: AgentDef, refresh = false): Promise<AgentStatus> {
  const project = statusProject();
  const base: AgentStatus = {
    agentId: agent.id,
    command: agent.command,
    ...checkInstalled(agent, project),
    install: agent.install ?? null,
    protocolVersion: null,
    agent: null,
    error: null,
    latest: await latestFor(agent, refresh),
    checkedAt: Date.now(),
  };
  /* A binary that is not there has nothing to say; spawning it would only
     turn the same fact into an ENOENT. */
  if (!base.installed) return base;
  /* Re-read the row: the caller's copy may predate an edit, and it is the
     command on the row that is about to be spawned. */
  if (!await getAgent(agent.id)) return base;
  try {
    const answered = await withAgentConnection(
      defaultProfileFor(agent.id, agent.name),
      agent.id,
      project,
      { name: "daedalus-status" },
      async (_conn, init) => ({
        protocolVersion: init.protocolVersion,
        agent: init.agentInfo
          ? { name: init.agentInfo.name, title: init.agentInfo.title ?? null, version: init.agentInfo.version ?? null }
          : null,
      }),
    );
    return { ...base, ...answered };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

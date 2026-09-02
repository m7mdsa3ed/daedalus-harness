import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
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
  checkedAt: number;
}

export interface AgentsStatus {
  /** The harness's half of the protocol: the SDK it speaks through and the
      version it asks for on every handshake. */
  acp: { sdkVersion: string; protocolVersion: number };
  agents: AgentStatus[];
}

/* The install line per built-in. A fact about the runtime like `quotaProbe`,
   but one nothing needs at spawn, so it is a table here rather than a column —
   and it is keyed by id, not by command, because the row's command is the
   user's to change and the package that provides the default one is not. */
const INSTALL_COMMANDS: Record<string, string> = {
  "claude-code": "npm install -g @agentclientprotocol/claude-agent-acp",
  codex: "npm install -g @agentclientprotocol/codex-acp",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  daedalus: "pnpm --dir agent install && pnpm --dir agent build",
};

export function installCommandFor(agentId: string): string | null {
  return INSTALL_COMMANDS[agentId] ?? null;
}

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
  const run = measure(agent)
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

async function measure(agent: AgentDef): Promise<AgentStatus> {
  const project = statusProject();
  const base: AgentStatus = {
    agentId: agent.id,
    command: agent.command,
    ...checkInstalled(agent, project),
    install: installCommandFor(agent.id),
    protocolVersion: null,
    agent: null,
    error: null,
    checkedAt: Date.now(),
  };
  /* A binary that is not there has nothing to say; spawning it would only
     turn the same fact into an ENOENT. */
  if (!base.installed) return base;
  /* Re-read the row: the caller's copy may predate an edit, and it is the
     command on the row that is about to be spawned. */
  if (!getAgent(agent.id)) return base;
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

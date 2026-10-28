import { createHash } from "node:crypto";
import { AcpConnection, AcpPool, pool } from "./acp-connection.js";

import { resolveAgentSpawn, spawnProcess, type SpawnSpec } from "./acp-bridge.js";
import { BUILTIN_MCP } from "./library.js";
import { PROBE_TIMEOUT_MS } from "./probe.js";
import { getAgent } from "./registry.js";
import type { PersonaSpawn } from "./personas.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import type { Handle } from "./sandbox/index.js";

/**
 * Agent processes booted ahead of a draft's first message, waiting to be
 * claimed by the thread that create finally makes.
 *
 * A thread starts as a draft: the client mints the id, and nothing exists on
 * the server until the first message (`docs/protocol.md`, "The client mints
 * session ids"). So the first send pays a whole cold start — `spawn`,
 * `initialize`, `session/new` — with the message already written and the send
 * button already pressed. This registry moves the first two behind the
 * keystrokes.
 *
 * **The draft still creates no row.** Nothing here writes to the database: no
 * `sessions` row, no journal, no `session/new`, no provider request, not one
 * token spent. The evidence that a prewarm happened at all is one console line.
 * That is the bargain of the draft, kept — moving creation earlier would undo
 * it, and it is not where the seconds are.
 *
 * **It stops at `initialize`, deliberately.** `session/new` is where the model,
 * the effort (for a profile with no catalog), the persona, the rules, the modes,
 * the MCP/skill/command union and the model allowlist are placed. A process
 * warmed past that point is a process with one thread's configuration on it, so
 * every config pick while the draft is still being written would have to spawn
 * again — which is exactly the cost this exists to avoid. Stopping at the
 * handshake costs nothing to re-enter: `initialize` is asked once per process,
 * so a claimed process resumes at `session/new` with the *final* picks.
 *
 * What a warm process may NOT be is handed to a thread that would have spawned
 * something else. `specKeyFor` over the resolved spawn is the whole safety
 * property; a claim compares it and refuses. A prewarm is also not a validated
 * process: `initialize` answering says the binary runs, not that the login,
 * the profile's credentials or the chosen model work — those still fail at
 * `session/new`, with the error and the Retry row a cold thread gets.
 */

/** How long a warm process waits for a thread. Refreshed by typing: a draft
    still being written keeps its process, one abandoned at ~2 minutes does not. */
export const PREWARM_TTL_MS = 120_000;

/** Ceiling on warm processes server-wide. A client's cancel may never arrive,
    so this — not the TTL, which is the same for all of them — is the real
    guarantee: a machine with ten idle projects cannot hold ten idle agents.
    The oldest goes first, because the draft that has stopped typing is the one
    that is not about to send. */
export const PREWARM_MAX = 4;

/** The handshake ceiling, the same one the options probe waits under: long
    enough for a cold agent to boot and answer, short enough that a wedged one
    does not sit in the registry forever. */
export const PREWARM_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/** A process nobody has claimed. Keyed by the draft id, which is what the
    client already knows and what `sessions.create` will ask about. */
interface Warm {
  conn: AcpConnection;
  /** Everything that would make this a different process (`specKeyFor`). */
  specKey: string;
  createdAt: number;
}

const warm = new Map<string, Warm>();

/** The pair a draft was warmed on, kept from the moment the spawn starts
    rather than from the moment it answers.
 *
 * The child is spawned against the draft's id, so its gateway URL is
 * thread-shaped and the shim has to resolve it (`gateway-shim.ts`,
 * `setGatewayDraftResolver`) — but no row names that id yet, so the manager
 * says no and the answer has to come from here. It is written before
 * `spawn`, because the window in which a process exists and cannot be
 * answered for is exactly the window this exists to close; and it goes with
 * the process, in the same `forget` a claim, a drop, an eviction and a sweep
 * all go through. */
/** The draft's pair, with the clock the sweep ages it by — a spawn that never
    lands must not keep answering for a process forever. */
interface Pair {
  profileId: string;
  agentId: string;
  at: number;
}

const pairs = new Map<string, Pair>();

/** What the draft resolver answers: the pair this draft was warmed on, while
    there is a process to serve it. Undefined once anything has let it go — so
    a claimed thread is never answered from here, because the claim is what
    removes it. */
export function draftPairOf(sessionId: string): { profileId: string; agentId: string } | undefined {
  const pair = pairs.get(sessionId);
  return pair ? { profileId: pair.profileId, agentId: pair.agentId } : undefined;
}

/** Everything that ends ownership of a draft id: the process and the pair. One
    function because they cannot disagree — an id with a pair and no process
    would be answered with a profile for a child that is gone. */
function forget(sessionId: string): void {
  warm.delete(sessionId);
  pairs.delete(sessionId);
}

/** Prewarms in flight, by draft id: two keystrokes must not start two agents. */
const inflight = new Map<string, Promise<void>>();

/**
 * A stable hash of everything a spawn is: the command, its args, the cwd and
 * every env var, sorted so key order cannot make two identical spawns look
 * different. Hashed rather than kept whole — the env holds credentials, and
 * this string is compared in places a key ends up (`sessions.create`), never
 * read for its contents.
 *
 * Anything not in here is something the process cannot tell apart, which is
 * why the inputs are read off `resolveAgentSpawn`'s answer rather than off the
 * request: what a thread's spawn actually is, is that function's to decide.
 */
export function specKeyFor(spec: SpawnSpec): string {
  const env = Object.keys(spec.env)
    .sort()
    .map((k) => [k, spec.env[k]]);
  return createHash("sha1").update(JSON.stringify([spec.command, spec.args, spec.cwd, env])).digest("hex");
}

/** Whether a warm process is worth starting at all. A hosted agent outlives the
    server, and boot adoption resurrects it by the row that names it — a
    prewarmed one has no row, so it would be left running with no thread and no
    reader. Under `direct` (the default) a leftover is a child of this server
    and dies with it. */
export function prewarmEnabled(): boolean {
  // Read per call rather than at import: the value is the deployment's, and a
  // test that asks has to see what it set.
  return process.env.DAEDALUS_SANDBOX !== "hosted";
}

/** What a prewarm is asked for: the draft, and the picks that are env at spawn.
    Everything else a thread spawns with (persona, rules, links) is read at
    create, so it is not this function's to know. */
interface WarmRequest {
  sessionId: string;
  model?: string;
  effort?: string;
  persona?: PersonaSpawn;
  helperModels?: { role: string; model: string }[];
  /** The runtime shares one process per cwd and hands its threads their env per
      session (`AgentDef.sharedProcess`) rather than at spawn. Read off the row
      by the caller, which resolves the agent anyway. */
  shared?: boolean;
}

/**
 * Boot a process for this draft, if that is still worth doing.
 *
 * Never throws and never blocks a send: every failure — an agent that is not
 * installed, a handshake that times out, an exit before it answers — ends with
 * the process reaped, one line on `console.warn` and a return. The only
 * observable is that the first message is as slow as it always was.
 */
export async function prewarm(
  profile: Profile,
  agentId: string,
  project: Project,
  opts: { sessionId: string; model?: string; effort?: string; persona?: PersonaSpawn; helperModels?: { role: string; model: string }[]; shared?: boolean },
): Promise<void> {
  if (!prewarmEnabled()) return;
  const { sessionId } = opts;
  // Single-flight: a second keystroke waits for the first process instead of
  // starting a second one. Once it has landed, the attempt below finds an entry
  // with this spec and only refreshes its clock.
  const running = inflight.get(sessionId);
  if (running) await running.catch(() => {});
  const run = attempt(profile, agentId, project, opts);
  inflight.set(sessionId, run);
  try {
    await run;
  } finally {
    if (inflight.get(sessionId) === run) inflight.delete(sessionId);
  }
}

/**
 * Warm the pool a shared runtime's threads come out of.
 *
 * Same ceiling and the same failure line as `boot`, because it is the same
 * question — does this binary answer `initialize` — asked of a process the
 * thread will not own. Nothing is registered: the pool is where `start` looks,
 * keyed by the spec it resolved, so a hit there is the whole of the warm-up and
 * a thread that never sends costs one idle process the pool retires on its own
 * clock.
 */
async function warmShared(agentId: string, sessionId: string, spec: SpawnSpec): Promise<void> {
  /* The thread's env rides its session on this runtime, so the process is
     spawned without it — the key `start` will ask for. */
  const bare = { ...spec, env: {} };
  let conn: AcpConnection | null = null;
  let expire: ReturnType<typeof setTimeout> | undefined;
  let opened: Promise<AcpConnection> | null = null;
  try {
    opened = deps.poolAcquire(agentId, AcpPool.key(bare), () => deps.spawn(bare));
    const deadline = new Promise<never>((_, reject) => {
      expire = setTimeout(() => reject(new Error(`initialize did not answer in ${deps.timeoutMs}ms`)), deps.timeoutMs);
      expire.unref();
    });
    conn = await Promise.race([opened, deadline]);
    await Promise.race([conn.initialized, deadline]);
    /* Nobody is on it; the pool's own idle clock is what ends it, exactly as it
       ends one a closed thread leaves behind. */
    deps.poolRelease(conn);
    console.log(`[prewarm] ${agentId} pooled for draft ${sessionId}`);
  } catch (error) {
    /* A process this call started and could not open must not be left behind —
       the pool has it only once `acquire` resolved. If it had not resolved yet
       it still may, so the arrival is killed too: a wedged process handing
       itself to the next thread would be worse than no warming at all. */
    conn?.kill();
    void opened
      ?.then((late) => {
        if (late !== conn) late.kill();
      })
      .catch(() => {});
    console.warn(`[prewarm] ${agentId} for draft ${sessionId}: ${messageOf(error)}`);
  } finally {
    clearTimeout(expire);
  }
}

/** One prewarm try: resolve, spawn, register. Logs its own failure. */
async function attempt(profile: Profile, agentId: string, project: Project, opts: WarmRequest): Promise<void> {
  const { sessionId } = opts;
  let spec: SpawnSpec;
  try {
    spec = await deps.resolve(profile, agentId, project, opts);
  } catch (error) {
    // Unknown agent, a profile that cannot spawn it, an unreadable config —
    // all of them are "no warm process", never a failed keystroke.
    console.warn(`[prewarm] ${agentId} for draft ${sessionId}: ${messageOf(error)}`);
    return;
  }
  /* A runtime whose threads share one process does not get a process of this
     draft's own, and must not: `start` spawns it through the pool, keyed on the
     spec with the thread's env taken out of it (`sharedProcess`, the env rides
     `_meta` per session). A connection registered here would be a second
     process under a key no thread ever asks for, so warming means warming the
     pool — the same thing `probeShared` does — and there is nothing to claim
     afterwards: `start`'s own `pool.acquire` is what finds it. */
  if (opts.shared) {
    await warmShared(agentId, sessionId, spec);
    return;
  }

  const specKey = specKeyFor(spec);
  const existing = warm.get(sessionId);
  if (existing) {
    /* Typing again with nothing changed is a clock refresh, not a spawn. */
    if (existing.specKey === specKey) {
      existing.createdAt = Date.now();
      pairs.set(sessionId, { profileId: profile.id, agentId, at: Date.now() });
      return;
    }
    /* The spawn it would be is now a different one — a profile, a cwd, an env
       var. A warm process is only ever worth something as the process the
       thread would have started, so this one is dead weight. */
    drop(sessionId);
  }

  /* Recorded before the spawn and never after: a child answering `initialize`
     on this draft's thread-shaped gateway URL is a request the shim resolves
     the moment it arrives, and the row that would answer it does not exist
     yet. `drop` above has just cleared the old pair, so this is the pair the
     process being started now will bill to. */
  pairs.set(sessionId, { profileId: profile.id, agentId, at: Date.now() });

  const spawned = await boot(agentId, sessionId, spec);
  if (!spawned) {
    /* Nothing to answer for: no process, so the pair goes with the failure. */
    forget(sessionId);
    return;
  }

  const { conn, proc } = spawned;
  const entry: Warm = { conn, specKey, createdAt: Date.now() };
  /* A process that ends on its own leaves with its entry, the way `AcpPool.adopt`'s
     `forget` does — otherwise the registry counts a corpse against the cap and
     hands it to a thread that would get a dead pipe. The pair goes with it, for
     the same reason: no process, nothing to resolve a request for. */
  const gone = () => {
    if (warm.get(sessionId) === entry) forget(sessionId);
  };
  proc.on("exit", gone);
  proc.on("error", gone);
  evictOldest();
  warm.set(sessionId, entry);
  console.log(`[prewarm] ${agentId} warm for draft ${sessionId}`);
}

/**
 * Spawn one process and wait for its `initialize`, or none.
 *
 * The connection is built the way `AcpPool.spawnConn` builds one, with the one
 * difference that makes it claimable: `shared` is false and there is no pool
 * key, so nothing else can find it, reuse it or hand it out — the registry is
 * the only owner it has until a thread claims it. `AcpConnection` is also what
 * asks `initialize` (with the same `CLIENT_CAPABILITIES` a thread's process
 * claims), so there is no client to build here and nothing to send after it.
 */
async function boot(agentId: string, sessionId: string, spec: SpawnSpec): Promise<{ conn: AcpConnection; proc: Handle } | null> {
  const started = Date.now();
  let proc: Handle | null = null;
  let conn: AcpConnection | null = null;
  let expire: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = await deps.spawn(spec);
    const child = proc;
    /* Nobody else reads this process's stderr, and an unread pipe eventually
       blocks the child, so it is drained from the first byte. The tail is what
       the failure line quotes — an agent that dies before answering says why
       there and nowhere else. */
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.length > 40) stderr.shift();
    });
    const tail = () => (stderr.length ? `: ${stderr.join("").trim().slice(-400)}` : "");
    conn = deps.connect(agentId, child);
    const exited = new Promise<never>((_, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`exited before answering (${code ?? "signal"})${tail()}`)));
    });
    const deadline = new Promise<never>((_, reject) => {
      expire = setTimeout(() => reject(new Error(`initialize did not answer in ${deps.timeoutMs}ms${tail()}`)), deps.timeoutMs);
      expire.unref();
    });
    await Promise.race([conn.initialized, exited, deadline]);
    return { conn, proc: child };
  } catch (error) {
    // A process that is not going to be claimed must not be left running — the
    // registry has no entry for it, so no sweep will ever find it.
    if (conn) conn.kill();
    else proc?.kill("SIGTERM");
    console.warn(`[prewarm] ${agentId} for draft ${sessionId}: ${messageOf(error)}`);
    return null;
  } finally {
    clearTimeout(expire);
  }
}

/** Hand over the process warmed for this draft, if it is still the process the
    caller is about to spawn.
 *
 * The comparison is the whole point: a warm process whose spawn no longer
 * matches — a profile switched while the draft was being written — is a process
 * the thread would not have started, and handing it over would bill a request
 * to a provider nobody picked. It is removed either way, because a draft is
 * single-use: a respawn inside it must not find the same entry twice.
 */
export function claim(sessionId: string, specKey: string): AcpConnection | null {
  /* The pair goes whether or not the claim succeeds: a thread exists by the time
     this is asked, so the manager answers for it, and nothing may still be
     resolving a draft that has become one. A refusal is the same story — the
     process it described is about to die. */
  pairs.delete(sessionId);
  const entry = warm.get(sessionId);
  if (!entry) return null;
  warm.delete(sessionId);
  if (entry.specKey !== specKey) {
    // Nothing will ever claim a stale one, and it is out of the registry, so no
    // sweep can reach it either. It goes now.
    entry.conn.kill();
    return null;
  }
  return entry.conn;
}

/** Forget this draft's process and end it — the kill rule for a change that is
    env at spawn, and the best-effort cancel when a draft is emptied or closed.
    The pair goes too: after this there is nothing left to answer for. */
export function drop(sessionId: string): void {
  pairs.delete(sessionId);
  const entry = warm.get(sessionId);
  if (!entry) return;
  warm.delete(sessionId);
  entry.conn.kill();
}

/** The oldest entry, ties broken by insertion order: two prewarms inside one
    millisecond are still two, and the first one in is the one that has waited. */
function oldestEntry(): [string, Warm] | undefined {
  let picked: [string, Warm] | undefined;
  for (const entry of warm) if (!picked || entry[1].createdAt < picked[1].createdAt) picked = entry;
  return picked;
}

/** Make room under the cap *before* the insert, so the count never exceeds it
    even for the instant in between. */
function evictOldest(): void {
  while (warm.size >= PREWARM_MAX) {
    const oldest = oldestEntry();
    if (!oldest) return;
    forget(oldest[0]);
    oldest[1].conn.kill();
  }
}

/** Expire what nobody claimed. Runs on the existing minute tick beside
    `sweepIdle`: one clock for the whole registry rather than a timer per entry,
    which would only ever be a second thing to cancel on claim. */
export function sweepPrewarm(now = Date.now()): void {
  for (const [sessionId, entry] of warm) {
    if (now - entry.createdAt < PREWARM_TTL_MS) continue;
    forget(sessionId);
    entry.conn.kill();
  }
  /* A pair whose process never landed — a spawn still in `boot`, or one whose
     handshake is about to time out — has no entry above to date it, so it is
     aged here: a draft that never got a process must not keep answering for one
     forever. `boot` is bounded by the handshake ceiling, well inside this. */
  for (const [sessionId, pair] of pairs) if (now - pair.at >= PREWARM_TTL_MS) pairs.delete(sessionId);
}

/**
 * How a warm process is produced, kept behind one indirection so the registry's
 * own rules — the cap, the TTL, the spec-key refusal — are testable without an
 * agent binary on the box. Production leaves this alone.
 */
export interface PrewarmDeps {
  resolve(profile: Profile, agentId: string, project: Project, opts: WarmRequest): Promise<SpawnSpec>;
  spawn(spec: SpawnSpec): Promise<Handle>;
  connect(agentId: string, proc: Handle): AcpConnection;
  /** The pool a shared runtime's threads come out of (`AcpPool.acquire`). A
      seam because a shared prewarm registers nothing: the pool is the whole of
      what it leaves behind, so a test that stubs the spawn has to see it. */
  poolAcquire(agentId: string, key: string, start: () => Promise<Handle>): Promise<AcpConnection>;
  /** Hand it back with nobody on it, so the pool's idle clock ends it. */
  poolRelease(conn: AcpConnection): void;
  /** How long the handshake may take; `PREWARM_TIMEOUT_MS`, overridable so a
      test can watch a wedged agent be reaped without waiting out the real one. */
  timeoutMs: number;
}

const realDeps: PrewarmDeps = {
  /* The same spawn `sessions.start` resolves, on the draft's id: the gateway URL
     is keyed on the session id, so a process warmed for a draft is already
     pointed at the thread-shaped endpoint it will still need once the row
     exists. A draft has a person in front of it, so it is never `unattended`.
     Model and effort go in only when the profile owns the catalog, as they do
     there — otherwise they are placed at `session/new` and an overwrite of them
     while typing must not be a different process. */
  resolve: async (profile, agentId, project, opts) =>
    resolveAgentSpawn(
      profile,
      agentId,
      project,
      (profile.models?.length ?? 0) > 0 ? opts.model : undefined,
      (profile.models?.length ?? 0) > 0 ? opts.effort : undefined,
      opts.sessionId,
      opts.persona,
      undefined,
      opts.helperModels,
      /* Whether the thread delegates through the harness's `agents` server is
         decided at create from the link union, which a draft does not have yet.
         The one part of it that is knowable here is the half that is forced: a
         runtime whose row *requires* that server has it on every thread, so the
         spawn says `harness` and the claim matches. Everything else says
         nothing, and a thread that turns out to link the server fails the
         comparison and starts cold — the safe half of that bargain, and never
         the wrong process. */
      (await getAgent(agentId))?.requiredMcp?.includes(BUILTIN_MCP.agents.id) ? "harness" : undefined,
    ),
  spawn: spawnProcess,
  connect: (agentId, proc) => new AcpConnection(agentId, proc, false),
  poolAcquire: (agentId, key, start) => pool.acquire(agentId, key, start),
  poolRelease: (conn) => pool.release(conn),
  timeoutMs: PREWARM_TIMEOUT_MS,
};

let deps: PrewarmDeps = realDeps;

/**
 * Test seam: replace the spawner, the connection factory and the resolver, and
 * start from an empty registry. `__test(null)` puts the real ones back. The
 * registry is process-wide, so a test that installs fakes owns all of it —
 * that is why this clears it rather than merging into it.
 */
export function __test(overrides: Partial<PrewarmDeps> | null): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
  /* Cleared without killing: the entries belong to the fakes a test installed,
     and there is no real process behind them (or, when they were real, the
     caller replacing the deps is a test that is about to exit). */
  warm.clear();
  inflight.clear();
  pairs.clear();
}

/** One line's worth of an error, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

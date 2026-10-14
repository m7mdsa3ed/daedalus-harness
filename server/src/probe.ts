import { eq } from "drizzle-orm";
import * as acp from "./acp.js";
import { createHash } from "node:crypto";
import { agentOptions as agentOptionsTable, db } from "./db/index.js";
import { AcpBridge, CLIENT_CAPABILITIES, agentStream, resolveAgentSpawn, spawnAgent, spawnProcess } from "./acp-bridge.js";
import { AcpPool, SINK, pool } from "./acp-connection.js";
import { emptyLinks } from "./db/links.js";
import { ensureProjectDir, materializeModelAllowlist, materializeWorkspace } from "./materialize.js";
import { getConfig } from "./config.js";
import { getAgent, modelAllowlistFor } from "./registry.js";
import { listProfiles, type Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/** Long enough for a cold agent to boot and answer; short enough that a wedged
    one does not hold a request open. */
export const PROBE_TIMEOUT_MS = 25_000;

/** Ceiling on the per-model sweep below. Each step is a local state change in
    the agent, so this is cheap — but an agent offering hundreds of models
    should not turn one probe into a hundred round trips. */
const MAX_MODEL_SWEEP = 40;

/** When an answer probed at `probedAt` stops standing — null for never
    (`agentOptionsTtlHours: 0`). The key catches every change the harness makes
    (profile, agent, cwd, allowlist); this catches the ones it cannot see — an
    upgraded binary, a gateway that changed its catalog behind the same URL. */
const expiresAt = (probedAt: number): number | null => {
  const hours = getConfig().agentOptionsTtlHours;
  return hours > 0 ? probedAt + hours * 60 * 60 * 1000 : null;
};

/** The answer plus when it expires, so the client's copy expires with ours
    rather than on a clock of its own. */
export type ProbedOptions = AgentOptions & { expiresAt: number | null };

export interface AgentOptions {
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
  /**
   * Model value -> the option set the agent advertises while it is selected.
   *
   * Some options exist only for some models: opencode reveals `effort` for its
   * reasoning models and not for the rest. A draft has no process to ask, so
   * without this the menu could only ever show the options that happened to be
   * live when the snapshot was taken, and picking a reasoning model would
   * silently fail to reveal its effort selector.
   */
  byModel: Record<string, acp.SessionConfigOption[]>;
  /**
   * What the runtime can carry in a prompt — the agent's half of the
   * attachment decision (delivery.ts).
   *
   * It comes free: `withAgentConnection` already hands this the `initialize`
   * response and this function used to ignore it. It is what lets a **draft**
   * composer — which has no process, by construction — say whether the
   * screenshot it is holding will reach the model as an image or as a path,
   * and it inherits the DB cache and the client-side store the rest of this
   * object already travels in.
   */
  promptCapabilities?: acp.PromptCapabilities;
}

/** Select options may arrive grouped; the sweep wants one flat list. */
function flattenChoices(option: acp.SessionConfigOption): { value: string }[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

/** In-flight probes, keyed like the cache. Two tabs opening the same menu at
    once must not spawn two agents — the second waits on the first's answer. */
const inflight = new Map<string, Promise<ProbedOptions>>();

/* `PROBE_SHAPE` is hashed in too: it names the client capabilities the answer
   was given under. Answers cached before the probe declared AIR's
   `recommendedValue` still hold Claude Code's `default` model/effort rows,
   which a live thread is no longer offered. Bump it when the declared
   capabilities change what an agent advertises. */
const PROBE_SHAPE = "air-recommended-1";

/**
 * cwd is in the key because it changes the answer: an agent reports different
 * options in different workspaces. So does the model allowlist, and for an
 * `"acp"`-live agent it changes the *model* list specifically — it is the
 * picker (see `materializeModelAllowlist`) — so it is hashed in beside the cwd
 * rather than left to `?refresh=1`. Which also means one profile gaining a
 * catalog invalidates the sibling profiles whose allowlist it widens, where
 * `updateProfile`'s own eviction only reaches the profile that was edited.
 *
 * Hashed, not spelled out: a union of forty gateway ids is not a database key,
 * and the list itself is on the row's answer anyway. The prefix stays
 * `<profileId>:<agentId>:` because both evictions match on it with LIKE.
 */
const cacheKey = (profile: Profile, agentId: string, project: Project, allowlist: string[]) =>
  `${profile.id}:${agentId}:${project.cwd}:${createHash("sha1")
    .update([PROBE_SHAPE, ...[...allowlist].sort()].join("\0"))
    .digest("hex")
    .slice(0, 8)}`;

/** The `availableModels` a probe of this pair would spawn behind — empty for
    every agent that does not build its picker from one. */
async function allowlistFor(profile: Profile, agentId: string): Promise<string[]> {
  const agent = await getAgent(agentId);
  return agent?.liveConfig === "acp" ? modelAllowlistFor(agent, profile, await listProfiles()) : [];
}

/**
 * What this profile's agent can be configured with — from cache when we have
 * asked before, and otherwise by asking, once.
 *
 * Asking means spawning an agent and killing it, so the answer is worth
 * keeping. It is cached in the database rather than per page-load in the
 * browser, which is what it was before: the old arrangement re-spawned an agent
 * for every tab, and forgot everything on reload.
 *
 * `refresh` is the escape hatch for the cases the key cannot see — an upgraded
 * agent binary, or a changed gateway catalog behind the same base URL.
 */
export async function probeAgentOptions(
  profile: Profile,
  agentId: string,
  project: Project,
  { refresh = false } = {},
): Promise<ProbedOptions> {
  const allowlist = await allowlistFor(profile, agentId);
  const key = cacheKey(profile, agentId, project, allowlist);
  if (!refresh) {
    const hit = (await db
      .select()
      .from(agentOptionsTable)
      .where(eq(agentOptionsTable.key, key))
      .limit(1))[0];
    const expires = hit ? expiresAt(hit.probedAt) : undefined;
    if (hit && (expires === null || Date.now() < expires!)) {
      return { ...(hit.options as AgentOptions), expiresAt: expires ?? null };
    }
  }
  const running = inflight.get(key);
  if (running) return running;

  const run = runProbe(profile, agentId, project, allowlist)
    .then(async (options) => {
      const row = { key, options, probedAt: Date.now() };
      await db.insert(agentOptionsTable)
        .values(row)
        .onConflictDoUpdate({ target: agentOptionsTable.key, set: row });
      return { ...options, expiresAt: expiresAt(row.probedAt) };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** Forget every probed answer — Settings › Agents' "Clear cached options". The
    next ask for each pair spawns again. */
export async function clearProbeCache(): Promise<void> {
  await db.delete(agentOptionsTable);
}

/** What a thread on this profile would see before its own picks, written
    where the probe is about to open a session. */
async function prepareWorkspace(agentId: string, project: Project, allowlist: string[]): Promise<void> {
  const layout = (await getAgent(agentId))?.workspaceLayout;
  ensureProjectDir(project.cwd);
  if (layout) {
    // What a thread on this profile would see before its own picks. Additive
    // only — a live thread in the same cwd keeps whatever it already has, since
    // the sweep is by presence. Into the directory *this* runtime reads
    // (`AgentDef.workspaceLayout`); a runtime that reads none is written none.
    materializeWorkspace(project.cwd, layout, emptyLinks());
    /* And the model allowlist a thread on this profile would spawn with — the
       probe's whole job is to answer what that thread's menu would contain, and
       for an `"acp"`-live agent the menu *is* this file (see
       `materializeModelAllowlist`). Without it the probe reported whatever the
       last spawn in this cwd happened to leave behind: a gateway's ids for the
       Default profile, or the agent's built-ins for a gateway profile that had
       not been spawned here yet. Unlike the links above this is a replacement
       rather than an addition, which is safe for the same reason the spawn's
       write is — the allowlist is read once, at `session/new`, so a live thread
       in this cwd already has its picker and the next spawn writes its own. */
    if ((await getAgent(agentId))?.liveConfig === "acp") {
      materializeModelAllowlist(project.cwd, layout, allowlist);
    }
  }
}

/**
 * Spawn an agent, run `initialize`, ask it one question, kill it.
 *
 * The scaffolding around that — the child's last words when it dies before
 * answering, the deadline a wedged agent cannot be talked out of, and the
 * SIGTERM→SIGKILL pair that stops a probe child outliving the request that
 * spawned it — is the same whatever the question is, so it lives here and both
 * callers (`runProbe` below, `listAgentSessions` in `session-list.ts`) use it.
 *
 * `materialize` is the one thing that is NOT shared and must not be: the probe
 * writes the profile's skills and model allowlist into the cwd because it is
 * about to open a session there and its whole job is to answer what that
 * session would offer. A caller that never opens one has no business writing
 * into anybody's workspace, so it leaves this off.
 */
export async function withAgentConnection<T>(
  profile: Profile,
  agentId: string,
  project: Project,
  opts: { name: string; materialize?: { allowlist: string[] } },
  fn: (agent: acp.ClientContext, init: acp.InitializeResponse) => Promise<T>,
): Promise<T> {
  if (opts.materialize) await prepareWorkspace(agentId, project, opts.materialize.allowlist);
  const proc = await spawnAgent(profile, agentId, project);

  const stderr: string[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
    if (stderr.length > 40) stderr.shift();
  });

  /* An agent that exits before answering rejects with its own last words. The
     SDK would otherwise report a closed connection, which never explains why. */
  const died = new Promise<never>(async (_, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) =>
      reject(
        new Error(
          `${agentId} exited before answering (${code ?? "signal"})${
            stderr.length ? `: ${stderr.join("").trim().slice(-400)}` : ""
          }`,
        ),
      ),
    );
  });
  died.catch(() => {});

  /* A cooperative `cancellationSignal` would not help here: it still waits for
     the peer's eventual response, and a wedged agent has none to give. */
  let expire: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    expire = setTimeout(() => reject(new Error("the agent did not answer in time")), PROBE_TIMEOUT_MS);
    expire.unref();
  });
  deadline.catch(() => {});

  try {
    return await Promise.race([
      acp.client({ name: opts.name }).connectWith(agentStream(proc), async (agent) => {
        const init = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          /* The same claims a thread's process makes, so the probe is
             answered in the shape a live thread will be: an AIR client gets
             concrete model/effort rows and a `recommendedValue`, anything else
             Claude Code's `default` rows. Nothing here serves a prompt, so the
             claims about output and plans cost nothing. */
          clientCapabilities: CLIENT_CAPABILITIES,
        });
        return fn(agent, init);
      }),
      died,
      deadline,
    ]);
  } finally {
    clearTimeout(expire!);
    // connectWith closes the connection; the process is ours to end. SIGTERM
    // first, then SIGKILL for an agent that ignores it — the same pair ide.ts
    // uses, because a wedged probe child otherwise outlives the request that
    // spawned it.
    proc.kill("SIGTERM");
    setTimeout(async () => {
      if (proc.running) proc.kill("SIGKILL");
    }, 5000).unref?.();
  }
}

/**
 * Ask an agent what it can be configured with, then throw it away.
 *
 * A thread that has not been sent yet has no agent process, so nothing can say
 * what its models, modes or switches are — the client would have to offer an
 * empty menu until the first message, which is after the point where
 * configuring it was useful. This spawns one, runs the handshake far enough to
 * get `session/new`'s answer, and kills it.
 *
 * The session it opens is real and stays in the agent's own store. That is the
 * price of asking: ACP has no way to enumerate configuration without one.
 */
async function runProbe(
  profile: Profile,
  agentId: string,
  project: Project,
  allowlist: string[],
): Promise<AgentOptions> {
  if ((await getAgent(agentId))?.sharedProcess === "acp-meta") {
    return await probeShared(profile, agentId, project, allowlist);
  }
  return withAgentConnection(
    profile,
    agentId,
    project,
    { name: "daedalus-probe", materialize: { allowlist } },
    async (agent, init) => {
      const created = await agent.request(acp.methods.agent.session.new, {
        cwd: project.cwd,
        mcpServers: [],
      });
      return await sweep(agent, agentId, init, created);
    },
  );
}

/**
 * The probe for a runtime whose threads share a process: asked on the pooled
 * process a thread in this cwd would get (`AcpPool`), with its session closed
 * afterwards rather than the process killed. So the draft that asked leaves a
 * process behind that has already paid its `initialize`, and its first message
 * starts at `session/new`. The profile's env rides the session, as a thread's
 * does. A timeout abandons the session, never the process — other threads may
 * be on it.
 */
async function probeShared(
  profile: Profile,
  agentId: string,
  project: Project,
  allowlist: string[],
): Promise<AgentOptions> {
  await prepareWorkspace(agentId, project, allowlist);
  const spec = await resolveAgentSpawn(profile, agentId, project);
  const env = spec.env;
  spec.env = {};
  const conn = await pool.acquire(agentId, AcpPool.key(spec), () => spawnProcess(spec));
  let sessionId: string | null = null;
  const sink = { ...SINK, ownsSession: (id: string) => id === sessionId };
  conn.attach(sink);
  let expire: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    expire = setTimeout(() => reject(new Error("the agent did not answer in time")), PROBE_TIMEOUT_MS);
    expire.unref();
  });
  try {
    return await Promise.race([
      (async () => {
        const init = await conn.initialized;
        const created = await conn.create(sink, () =>
          conn.rpc.agent.request(acp.methods.agent.session.new, {
            cwd: project.cwd,
            mcpServers: [],
            _meta: AcpBridge.sessionEnvMeta(env),
          }),
        );
        sessionId = created.sessionId;
        return await sweep(conn.rpc.agent, agentId, init, created);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(expire!);
    conn.detach(sink, sessionId);
  }
}

/** Read what a fresh session offers, and what each model brings with it. */
async function sweep(
  agent: Pick<acp.ClientContext, "request">,
  agentId: string,
  init: acp.InitializeResponse,
  created: acp.NewSessionResponse,
): Promise<AgentOptions> {
  const configOptions = created.configOptions ?? [];

  /* Walk the model list, asking what each one brings with it. One extra
     call per model on a process that is already up and about to be
     discarded — far cheaper than spawning again later, and the only way a
     draft can know that picking a reasoning model should reveal an effort
     selector. */
  const byModel: Record<string, acp.SessionConfigOption[]> = {};
  const model = configOptions.find((o) => o.category === "model" && o.type === "select");
  if (model) {
    const choices = flattenChoices(model);
    if (choices.length > MAX_MODEL_SWEEP) {
      console.warn(
        `[probe] ${agentId}: sweeping ${MAX_MODEL_SWEEP} of ${choices.length} models`,
      );
    }
    for (const choice of choices.slice(0, MAX_MODEL_SWEEP)) {
      try {
        const set = await agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: created.sessionId,
          configId: model.id,
          value: choice.value,
        });
        if (set.configOptions) byModel[choice.value] = set.configOptions;
      } catch {
        // A model the agent will not select is one the menu can fall back on.
      }
    }
  }
  return {
    modes: created.modes ?? null,
    configOptions,
    byModel,
    ...(init.agentCapabilities?.promptCapabilities
      ? { promptCapabilities: init.agentCapabilities.promptCapabilities }
      : {}),
  };
}

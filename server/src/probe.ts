import { eq } from "drizzle-orm";
import * as acp from "@agentclientprotocol/sdk";
import { agentOptions as agentOptionsTable, db } from "./db/index.js";
import { agentStream, spawnAgent } from "./acp-bridge.js";
import { unionLinks } from "./db/links.js";
import { materializeWorkspace } from "./materialize.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/** Long enough for a cold agent to boot and answer; short enough that a wedged
    one does not hold a request open. */
const PROBE_TIMEOUT_MS = 25_000;

/** Ceiling on the per-model sweep below. Each step is a local state change in
    the agent, so this is cheap — but an agent offering hundreds of models
    should not turn one probe into a hundred round trips. */
const MAX_MODEL_SWEEP = 40;

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
}

/** Select options may arrive grouped; the sweep wants one flat list. */
function flattenChoices(option: acp.SessionConfigOption): { value: string }[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

/** In-flight probes, keyed like the cache. Two tabs opening the same menu at
    once must not spawn two agents — the second waits on the first's answer. */
const inflight = new Map<string, Promise<AgentOptions>>();

/** cwd is in the key because it changes the answer: an agent reports different
    options in different workspaces. */
const cacheKey = (profile: Profile, agentId: string, project: Project) =>
  `${profile.id}:${agentId}:${project.cwd}`;

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
export function probeAgentOptions(
  profile: Profile,
  agentId: string,
  project: Project,
  { refresh = false } = {},
): Promise<AgentOptions> {
  const key = cacheKey(profile, agentId, project);
  if (!refresh) {
    const hit = db
      .select()
      .from(agentOptionsTable)
      .where(eq(agentOptionsTable.key, key))
      .get();
    if (hit) return Promise.resolve(hit.options as AgentOptions);
  }
  const running = inflight.get(key);
  if (running) return running;

  const run = runProbe(profile, agentId, project)
    .then((options) => {
      const row = { key, options, probedAt: Date.now() };
      db.insert(agentOptionsTable)
        .values(row)
        .onConflictDoUpdate({ target: agentOptionsTable.key, set: row })
        .run();
      return options;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
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
async function runProbe(profile: Profile, agentId: string, project: Project): Promise<AgentOptions> {
  // What a thread on this profile would see before its own picks. Additive
  // only — a live thread in the same cwd keeps whatever it already has, since
  // the sweep is by presence.
  materializeWorkspace(project.cwd, unionLinks(profile));
  const proc = spawnAgent(profile, agentId, project);

  const stderr: string[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
    if (stderr.length > 40) stderr.shift();
  });

  /* An agent that exits before answering rejects with its own last words. The
     SDK would otherwise report a closed connection, which never explains why. */
  const died = new Promise<never>((_, reject) => {
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
      acp.client({ name: "daedalus-probe" }).connectWith(agentStream(proc), async (agent) => {
        await agent.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              session: { configOptions: { boolean: {} } },
            },
          },
        );
        const created = await agent.request(acp.methods.agent.session.new, {
          cwd: project.cwd,
          mcpServers: [],
        });
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
        return { modes: created.modes ?? null, configOptions, byModel };
      }),
      died,
      deadline,
    ]);
  } finally {
    clearTimeout(expire!);
    // connectWith closes the connection; the process is ours to end.
    proc.kill();
  }
}

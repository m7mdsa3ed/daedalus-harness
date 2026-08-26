import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { agentOptions as agentOptionsTable, db } from "./db/index.js";
import { getAgent, resolveSpawn } from "./registry.js";
import { materializeProject } from "./materialize.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/** Long enough for a cold agent to boot and answer; short enough that a wedged
    one does not hold a request open. */
const PROBE_TIMEOUT_MS = 25_000;

/** Ceiling on the per-model sweep below. Each step is a local state change in
    the agent, so this is cheap — but an agent offering hundreds of models
    should not turn one probe into a hundred round trips. */
const MAX_MODEL_SWEEP = 40;

interface ConfigOption {
  id: string;
  type?: string;
  category?: string | null;
  currentValue?: unknown;
  options?: unknown[];
}

export interface AgentOptions {
  modes: unknown;
  configOptions: ConfigOption[];
  /**
   * Model value -> the option set the agent advertises while it is selected.
   *
   * Some options exist only for some models: opencode reveals `effort` for its
   * reasoning models and not for the rest. A draft has no process to ask, so
   * without this the menu could only ever show the options that happened to be
   * live when the snapshot was taken, and picking a reasoning model would
   * silently fail to reveal its effort selector.
   */
  byModel: Record<string, ConfigOption[]>;
}

/** Select options may arrive grouped; the sweep wants one flat list. */
function flattenChoices(options: unknown[] | undefined): { value: string }[] {
  return (options ?? []).flatMap((entry) => {
    const group = entry as { options?: unknown[] };
    return (group && typeof group === "object" && Array.isArray(group.options)
      ? group.options
      : [entry]) as { value: string }[];
  });
}

/** In-flight probes, keyed like the cache. Two tabs opening the same menu at
    once must not spawn two agents — the second waits on the first's answer. */
const inflight = new Map<string, Promise<AgentOptions>>();

/** cwd is in the key because it changes the answer: an agent reports different
    options in different workspaces. */
const cacheKey = (profile: Profile, project: Project) =>
  `${profile.id}:${profile.agentId}:${project.cwd}`;

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
  project: Project,
  { refresh = false } = {},
): Promise<AgentOptions> {
  const key = cacheKey(profile, project);
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

  const run = runProbe(profile, project)
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
async function runProbe(profile: Profile, project: Project): Promise<AgentOptions> {
  const agent = getAgent(profile.agentId);
  if (!agent) throw new Error(`unknown agent: ${profile.agentId}`);
  materializeProject(project);
  const { command, args, env, cwd } = resolveSpawn(agent, profile, project);

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr: string[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
    if (stderr.length > 40) stderr.shift();
  });

  let buffer = "";
  let nextId = 0;
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number" && waiting.has(msg.id)) {
          waiting.get(msg.id)!(msg as Record<string, unknown>);
          waiting.delete(msg.id);
        }
      } catch {
        // Not JSON: an agent logging to stdout. Nothing here to answer.
      }
    }
  });

  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`${method} timed out`));
      }, PROBE_TIMEOUT_MS).unref();
    });

  const failed = new Promise<never>((_, reject) => {
    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) =>
      reject(
        new Error(
          `${agent.name} exited before answering (${code ?? "signal"})${
            stderr.length ? `: ${stderr.join("").trim().slice(-400)}` : ""
          }`,
        ),
      ),
    );
  });

  try {
    await Promise.race([
      call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
        },
      }),
      failed,
    ]);
    const created = (await Promise.race([
      call("session/new", { cwd: project.cwd, mcpServers: [] }),
      failed,
    ])) as { result?: { modes?: unknown; configOptions?: unknown[] }; error?: unknown };
    if (created.error) throw new Error(JSON.stringify(created.error).slice(0, 400));
    const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
    const configOptions = (created.result?.configOptions ?? []) as ConfigOption[];

    /* Walk the model list, asking what each one brings with it. One extra call
       per model on a process that is already up and about to be discarded —
       far cheaper than spawning again later, and the only way a draft can know
       that picking a reasoning model should reveal an effort selector. */
    const byModel: Record<string, ConfigOption[]> = {};
    const model = configOptions.find((o) => o.category === "model" && o.type === "select");
    if (sessionId && model) {
      const choices = flattenChoices(model.options);
      if (choices.length > MAX_MODEL_SWEEP) {
        console.warn(
          `[probe] ${agent.name}: sweeping ${MAX_MODEL_SWEEP} of ${choices.length} models`,
        );
      }
      for (const choice of choices.slice(0, MAX_MODEL_SWEEP)) {
        try {
          const set = (await Promise.race([
            call("session/set_config_option", {
              sessionId,
              configId: model.id,
              value: choice.value,
            }),
            failed,
          ])) as { result?: { configOptions?: ConfigOption[] } };
          if (set.result?.configOptions) byModel[choice.value] = set.result.configOptions;
        } catch {
          // A model the agent will not select is one the menu can fall back on.
        }
      }
    }
    return { modes: created.result?.modes ?? null, configOptions, byModel };
  } finally {
    proc.kill();
  }
}

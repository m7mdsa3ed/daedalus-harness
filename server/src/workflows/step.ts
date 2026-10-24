/*
 * Workflow engine v2: one agent step.
 *
 * `runAgentStep` is the whole life of one `agent(prompt, opts)` call that the
 * engine decided has to really run: spawn (or resume) a child thread, prompt
 * it, wait for the turn against the step clock and the run's cancel, validate
 * a JSON reply with one repair turn, retry with backoff (same thread, fallback
 * model from the second attempt), mirror everything onto the parent's
 * transcript in the shape the existing client card decodes, journal the
 * outcome and retire the child.
 *
 * It is the v1 `runStep`/`resumeChild`/`promptAndWait` with the scheduler, the
 * records and the pump taken out: the engine (engine.ts) owns *whether and
 * when* a step runs and what its answer means to the script; this file owns
 * *how* one step runs. It touches the run only through `StepContext`, which is
 * what lets the engine's replay logic be tested with a fake runner.
 *
 * Things this file chose that the contract left open (see the report):
 *  - `spec.tools` has no door in the runtimes (no per-thread allow/deny list
 *    reaches `manager.create`), so it is stated as a sentence at the head of
 *    the prompt. `spec.system` likewise (personas no longer exist): a labelled
 *    block at the head of the prompt.
 *  - A `schema` is also *told* to the child (the JSON Schema and the fence
 *    rule are appended to the prompt). v1 only said it in the repair turn.
 *  - `tokens` in the result is OUTPUT tokens (what `Budgets.tokens` counts);
 *    the fold sums it into `usage.tokens`.
 */
import { randomUUID } from "node:crypto";
import type { AutonomyPolicy } from "../autonomy.js";
import { checkInstalled } from "../agent-status.js";
import { commands as commandLibrary } from "../library.js";
import { getProfile, listProfiles, type Profile } from "../profiles.js";
import { getProject, type Project } from "../projects.js";
import type { ThreadEvent } from "../protocol.js";
import { listAgents } from "../registry.js";
import type { Session, SessionManager, TurnOutcome } from "../sessions.js";
import { OutputError, describe, extractJsonOutput, validateOutput } from "./graph.js";
import { estimateCostUsd } from "./limits.js";
import { ENGINE_LIMITS, type AgentSpec, type JournalEvent, type JournalPayload, type OnRestart } from "./types.js";

type UpdateEvent = Extract<ThreadEvent, { ev: "update" }>;

/** The slice of the session manager a step drives. */
export type StepManager = Pick<
  SessionManager,
  "create" | "respawn" | "get" | "prompt" | "subscribe" | "whenTurnSettled" | "retire" | "emitOn"
>;

/** Who an ask went to: drawn as `_meta.daedalus.ask` instead of `workflow`. */
export interface AskInfo {
  agent: string;
  profile: string;
  agentId: string;
  profileId: string;
  /** The errand in the caller's words: names the child and its row. */
  description?: string;
}

export interface Placement {
  /** Position among the steps the run has registered so far (0-based). */
  index: number;
  total: number;
  phase: { index: number; name: string } | null;
  plan: { name: string | null; steps: string[] }[];
  /** What this step reads by, and what every registered step does (keyed by step name). */
  title: string;
  titles: Record<string, string>;
}

/** A journaled `step_started` with no completion: the step was in flight at a restart. */
export interface Recovered {
  sessionId: string;
  attempt: number;
}

export interface StepContext {
  runId: string;
  runName: string;
  manager: StepManager;
  /** The thread that owns the run. */
  parent: Session;
  /** Aborted on cancel (and on shutdown: see `detached`). */
  signal: AbortSignal;
  /** The abort is a server shutdown: write nothing, the run resumes at boot. */
  detached(): boolean;
  /** Why the run was aborted (the engine's cancel reason: "stopped by the user", …), for the
      journaled `step_failed`. Absent or null = the plain word "cancelled". */
  cancelReason?: () => string | null;
  /** Set for a run drawn as an ask (a plain subagent, `_meta.daedalus.ask`). */
  ask: AskInfo | null;
  /** The child's permission policy (an ask grants everything: ASK_AUTONOMY). */
  autonomy?: AutonomyPolicy;
  /** Step clock when the spec names none; null = no limit (an ask's default). */
  defaultTimeoutSec: number | null;
  defaultOnRestart: OnRestart;
  recovered: Recovered | null;
  placement(): Placement;
  /** Parks while the run is paused. */
  whenRunning(): Promise<void>;
  /** A clock that stands still while the run is paused. `clear()` before dropping it. */
  timer(ms: number, fn: () => void): { clear(): void };
  append(key: string, payload: JournalPayload): Promise<JournalEvent>;
  /** Live children, so the engine can pause them with the run. */
  track(child: Session): void;
  untrack(child: Session): void;
}

export interface StepResult {
  output: unknown;
  sessionId: string | null;
  /** Output tokens, all turns of the step. */
  tokens: number;
  toolUses: number;
  costUsd: number;
}

/** A step that did not complete. Carries what it spent, so the engine can still meter it. */
export class StepError extends Error {
  tokens = 0;
  toolUses = 0;
  costUsd = 0;
  sessionId: string | null = null;
}

/** A step the restart policy `fail` failed on purpose: its `step_failed` is already journaled. */
export class StepRestartFailed extends StepError {}

/** The step could not even start (missing profile, project, command, …): retrying cannot help. */
export class StepConfigError extends StepError {}

/** The run was cancelled (or detached for a shutdown) while the step ran. */
export class StepCancelled extends StepError {}

const NOOP = () => {};

// ---- pairs ----------------------------------------------------------------

/** A (profile, agent) pair a thread may ask, as `list_agents` reports it. */
export interface AgentPair {
  profileId: string;
  profile: string;
  agentId: string;
  agent: string;
  installed: boolean;
  models: string[];
  defaultModel: string | null;
  /** The caller's own pair. */
  current: boolean;
}

/**
 * Every profile that is neither hidden nor disabled, crossed with the agents it
 * declares. Whether the agent is installed is measured against the caller's
 * project (a path check, never a handshake).
 */
export async function listPairs(parent: Session): Promise<AgentPair[]> {
  const project = await getProject(parent.projectId);
  const agents = await listAgents();
  const out: AgentPair[] = [];
  for (const profile of await listProfiles(agents)) {
    if (profile.hidden || profile.disabled) continue;
    for (const agentId of Object.keys(profile.agents)) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) continue;
      out.push({
        profileId: profile.id,
        profile: profile.name,
        agentId,
        agent: agent.name,
        installed: project ? checkInstalled(agent, project).installed : false,
        models: profile.models.map((m) => m.id),
        defaultModel: profile.defaultModel || null,
        current: profile.id === parent.profileId && agentId === parent.agentId,
      });
    }
  }
  return out;
}

const matches = (id: string, name: string, query: string) =>
  id === query || name.toLowerCase() === query.trim().toLowerCase();

/** Where a spec's step runs: the parent's own pair unless it names another. */
async function resolveTarget(
  ctx: StepContext,
  spec: AgentSpec,
): Promise<{
  profile: Profile;
  agentId: string;
  project: Project;
  model: string | undefined;
  effort: string | undefined;
  sameAgent: boolean;
  samePair: boolean;
}> {
  const parent = ctx.parent;
  let profileQuery = spec.profile;
  let agentQuery = spec.agent;
  let model = spec.model;
  let profile: Profile | undefined;
  let agentId = parent.agentId;
  if (profileQuery || agentQuery) {
    const all = await listPairs(parent);
    /* The person's choice for this thread outranks whatever the script passed
       (v1's rule for an ask): the point of setting it is that the model does
       not get to pick. */
    const named = agentQuery ? all.find((p) => matches(p.agentId, p.agent, agentQuery!)) : undefined;
    const preset = named ? parent.askProfiles?.[named.agentId] : undefined;
    if (named && preset) {
      agentQuery = named.agentId;
      profileQuery = preset.profileId;
      model = preset.model ?? model;
    }
    const wantAgent = agentQuery ?? parent.agentId;
    const wantProfile = profileQuery ?? parent.profileId;
    const hits = all.filter((p) => matches(p.profileId, p.profile, wantProfile) && matches(p.agentId, p.agent, wantAgent));
    const known = () => all.map((p) => `${p.profile} / ${p.agent}`).join(", ") || "none";
    if (hits.length === 0) {
      throw new StepConfigError(`no profile "${wantProfile}" with agent "${wantAgent}" — available: ${known()}`);
    }
    if (hits.length > 1) {
      throw new StepConfigError(`"${wantProfile}" / "${wantAgent}" matches ${hits.length} pairs — name the profile by id`);
    }
    const pair = hits[0]!;
    if (!pair.installed) throw new StepConfigError(`${pair.agent} is not installed on this server`);
    agentId = pair.agentId;
    profile = await getProfile(pair.profileId);
    if (!profile) throw new StepConfigError("that profile no longer exists");
  } else {
    profile = await getProfile(parent.profileId);
    if (!profile) throw new StepConfigError("this thread's profile no longer exists");
  }
  const projectId = spec.projectId ?? parent.projectId;
  const project = await getProject(projectId);
  if (!project) {
    throw new StepConfigError(spec.projectId ? `agent(…, {projectId}): no project "${spec.projectId}"` : "this thread's project no longer exists");
  }
  const sameAgent = agentId === parent.agentId;
  const samePair = sameAgent && profile.id === parent.profileId;
  return {
    profile,
    agentId,
    project,
    model: model ?? (samePair ? parent.model : undefined),
    effort: spec.effort ?? (samePair ? parent.effort : undefined),
    sameAgent,
    samePair,
  };
}

// ---- prompt ---------------------------------------------------------------

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function toolPolicy(tools: NonNullable<AgentSpec["tools"]>): string {
  const lines: string[] = [];
  if (tools.allow?.length) lines.push(`You may use only these tools: ${tools.allow.join(", ")}.`);
  if (tools.deny?.length) lines.push(`Do not use these tools: ${tools.deny.join(", ")}.`);
  return lines.length ? `Tool policy for this task (follow it strictly):\n${lines.join("\n")}` : "";
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    "Reply with a single JSON value in one ```json fence, matching this JSON Schema, and nothing else after it:\n" +
    JSON.stringify(schema)
  );
}

// ---- the step -------------------------------------------------------------

export async function runAgentStep(ctx: StepContext, spec: AgentSpec, key: string, name: string): Promise<StepResult> {
  const { parent } = ctx;
  const policy: OnRestart = spec.onRestart ?? ctx.defaultOnRestart;
  const rowName = ctx.ask ? (ctx.ask.description ?? `${ctx.ask.agent} · ${ctx.ask.profile}`) : ctx.placement().title;
  const maxAttempts = 1 + (spec.retry?.max ?? 0);
  const fallbackModel = spec.retry?.fallbackModel;
  const limitSec = Math.min(spec.timeoutSec ?? ctx.defaultTimeoutSec ?? Infinity, ENGINE_LIMITS.stepTimeoutSec.max);
  const timeoutSec = Number.isFinite(limitSec) ? limitSec : null;

  const acc = { text: "", bytes: 0, outputTokens: 0, totalTokens: 0, toolUses: 0 };
  let child: Session | null = null;
  let unsubscribe = NOOP;
  let attempt = 0;
  /* Whether this step has a `step_started` in the journal (a recovered one has, from before the
     restart). A step that fails before it ever spawns still gets one, so `usage.agents` and the
     card count it. */
  let startJournaled = !!ctx.recovered;

  const spent = () => ({
    tokens: acc.outputTokens || acc.totalTokens,
    toolUses: acc.toolUses,
    costUsd: estimateCostUsd(acc.outputTokens || acc.totalTokens),
  });
  const stateUpdate = (id: string, state: "completed" | "failed" | "cancelled" | "disconnected"): UpdateEvent => ({
    ev: "update",
    seq: 0,
    historyReplay: false,
    update: { sessionUpdate: "subagent_state_update", subagentSessionId: id, state },
  });

  try {
    // ---- a step that was in flight at a restart ----
    const recovered = ctx.recovered;
    if (recovered && policy === "fail") {
      const error = "the server restarted while this step was running";
      await ctx.append(key, {
        kind: "step_failed",
        name,
        error,
        sessionId: recovered.sessionId,
        tokens: 0,
        toolUses: 0,
      });
      ctx.manager.emitOn(parent.id, stateUpdate(recovered.sessionId, "failed"));
      throw failed(new StepRestartFailed(error), recovered.sessionId, spent());
    }
    if (recovered && policy === "rerun") {
      // The old thread is abandoned, not deleted: say so on its row.
      ctx.manager.emitOn(parent.id, stateUpdate(recovered.sessionId, "disconnected"));
    }
    const resumeId = spec.resumeSession ?? (recovered && policy === "resume" ? recovered.sessionId : undefined);
    /* A resumed step continues the attempt that was in flight rather than
       starting another, so a restart never eats a retry. */
    const continuing = !!recovered && policy === "resume";
    attempt = continuing ? Math.max(0, recovered!.attempt - 1) : 0;

    // ---- the prompt ----
    const lead = spec.agentType ? (await commandLibrary.list()).find((c) => c.name === spec.agentType) : undefined;
    if (spec.agentType && !lead) throw new StepConfigError(`agent(…, {agentType}): no slash command is named /${spec.agentType}`);
    const body = [
      spec.system ? `System instructions for this task:\n${spec.system}` : "",
      spec.tools ? toolPolicy(spec.tools) : "",
      lead ? lead.content.replaceAll("$ARGUMENTS", "").trim() : "",
      spec.prompt,
      spec.schema ? schemaInstruction(spec.schema) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    let target: Target | null = null;
    const targetOf = async (): Promise<Target> => (target ??= await resolveTarget(ctx, spec));

    // ---- the attempts ----
    let output: unknown;
    let lastError = "";
    let resumedFromScratch = false;
    for (;;) {
      await ctx.whenRunning();
      if (ctx.signal.aborted) throw new StepCancelled("cancelled");
      attempt += 1;
      const wantModel = attempt >= 2 && fallbackModel ? fallbackModel : undefined;

      let journaledAttempt = -1;
      if (!child) {
        if (resumeId !== undefined) {
          try {
            child = await reviveChild(ctx, resumeId, attempt >= 2 ? fallbackModel : undefined);
          } catch (error) {
            /* A step recovered at boot whose thread is gone (deleted, never persisted) is
               re-run from its prompt rather than failed; an explicit `resumeSession` that
               names a missing thread is the script's mistake and fails. */
            if (spec.resumeSession || !(error instanceof StepConfigError)) throw error;
            resumedFromScratch = true;
          }
        }
        if (!child) {
          const t = await targetOf();
          /* The id is minted and journaled BEFORE the thread exists: a crash between the two used
             to leave a live child no journal row named (an orphan nothing could resume or
             retire). Now the worst case is a `step_started` for a thread that was never made,
             which recovery already answers with a fresh spawn. */
          const id = randomUUID();
          await ctx.append(key, { kind: "step_started", name, phase: spec.phase, sessionId: id, attempt, startedAt: Date.now() });
          startJournaled = true;
          journaledAttempt = attempt;
          child = await spawnChild(ctx, spec, name, rowName, t, wantModel ?? t.model, id);
        }
        ctx.track(child);
        announce(ctx, child, spec, name, rowName);
        unsubscribe = mirror(ctx, child, acc);
        await child.bridge!.ready;
      } else if (attempt >= 2) {
        // Same thread, same conversation; a fallback model costs a respawn (a `session/load`).
        child = await reviveChild(ctx, child.id, fallbackModel);
      }

      if (journaledAttempt !== attempt) {
        await ctx.append(key, {
          kind: "step_started",
          name,
          phase: spec.phase,
          sessionId: child.id,
          attempt,
          startedAt: Date.now(),
        });
        startJournaled = true;
      }

      const fence = spec.schema ? `\n\n${schemaInstruction(spec.schema)}` : "";
      const first =
        attempt > 1 && !(continuing && attempt === recovered!.attempt)
          ? `Your previous attempt failed: ${lastError}\n\nTry again and finish the task.${fence}`
          : spec.resumeSession
            ? `${spec.prompt}${fence}`
            : continuing && !resumedFromScratch
              ? `Continue where you left off and finish the task.${fence}`
              : body;
      try {
        output = await converse(ctx, child, first, spec, timeoutSec, acc);
        break;
      } catch (error) {
        if (error instanceof StepCancelled || error instanceof StepConfigError) throw error;
        if (ctx.signal.aborted) throw new StepCancelled("cancelled");
        lastError = describe(error);
        if (attempt >= maxAttempts) throw error;
        const backoffSec = (spec.retry?.backoffSec ?? 2) * 2 ** (attempt - 1);
        await ctx.append(key, {
          kind: "step_retry",
          name,
          attempt: attempt + 1,
          error: lastError,
          backoffSec,
          ...(fallbackModel ? { model: fallbackModel } : {}),
        });
        if (!(await pausableSleep(ctx, backoffSec * 1000))) throw new StepCancelled("cancelled");
      }
    }

    const used = spent();
    await ctx.append(key, {
      kind: "step_completed",
      name,
      output,
      sessionId: child.id,
      tokens: used.tokens,
      toolUses: used.toolUses,
      costUsd: used.costUsd,
    });
    ctx.manager.emitOn(parent.id, stateUpdate(child.id, "completed"));
    return { output, sessionId: child.id, ...used };
  } catch (raw) {
    const error = raw instanceof StepError ? raw : failed(new StepError(describe(raw)), child?.id ?? null, spent());
    const used = spent();
    error.tokens = used.tokens;
    error.toolUses = used.toolUses;
    error.costUsd = used.costUsd;
    error.sessionId = child?.id ?? error.sessionId;
    if (error instanceof StepCancelled) {
      /* A shutdown writes nothing: the journaled `step_started` with no
         outcome is exactly what tells the next boot this step was in flight. */
      if (!ctx.detached()) {
        await ctx
          .append(key, {
            kind: "step_failed",
            name,
            error: ctx.cancelReason?.() || "cancelled",
            sessionId: error.sessionId,
            tokens: used.tokens,
            toolUses: used.toolUses,
          })
          .catch(NOOP);
        if (child) ctx.manager.emitOn(parent.id, stateUpdate(child.id, "cancelled"));
      }
    } else if (!(error instanceof StepRestartFailed)) {
      if (!startJournaled) {
        /* Failed before it spawned (a profile that is gone, a missing command, …): say it started
           first, with no thread, so the fold counts the agent and the failure has a row to land on. */
        await ctx
          .append(key, { kind: "step_started", name, phase: spec.phase, sessionId: "", attempt: Math.max(1, attempt), startedAt: Date.now() })
          .catch(NOOP);
      }
      /* What the step said before it stopped is the one thing a timed-out or
         failed step can still hand back: its parent reads it, and so does the
         `resumeSession` that picks it up. */
      await ctx
        .append(key, {
          kind: "step_failed",
          name,
          error: error.message,
          ...(acc.text.trim() ? { output: acc.text } : {}),
          sessionId: error.sessionId,
          tokens: used.tokens,
          toolUses: used.toolUses,
        })
        .catch(NOOP);
      if (child) ctx.manager.emitOn(parent.id, stateUpdate(child.id, "failed"));
    }
    throw error;
  } finally {
    unsubscribe();
    if (child) {
      ctx.untrack(child);
      ctx.manager.retire(child);
    }
  }
}

function failed(error: StepError, sessionId: string | null, used: { tokens: number; toolUses: number; costUsd: number }): StepError {
  error.sessionId = sessionId;
  error.tokens = used.tokens;
  error.toolUses = used.toolUses;
  error.costUsd = used.costUsd;
  return error;
}

// ---- spawning ---------------------------------------------------------------

type Target = Awaited<ReturnType<typeof resolveTarget>>;

async function spawnChild(
  ctx: StepContext,
  spec: AgentSpec,
  name: string,
  rowName: string,
  target: Target,
  model: string | undefined,
  id: string,
): Promise<Session> {
  const { parent } = ctx;
  /* A step inherits how its parent was configured — the permission mode above
     all, so a step does not ask what the parent would not. Another agent's mode
     ids are not ours to pass, so nothing crosses to it. */
  const restore = !target.sameAgent
    ? { configOptions: [] }
    : (parent.bridge?.captureRestoreState() ?? { modeId: parent.modeId ?? undefined, configOptions: [] });
  return await ctx.manager.create(
    target.profile,
    target.agentId,
    target.project,
    model ?? target.model,
    target.effort,
    id,
    undefined,
    parent.links,
    {
      parentSessionId: parent.id,
      childKind: ctx.ask ? "ask" : "workflow",
      ...(ctx.ask ? {} : { childRun: { id: ctx.runId, name: ctx.runName } }),
      title: ctx.ask ? `Ask · ${rowName}` : `${ctx.runName} · ${rowName}`,
      restore,
      /* A step works where its parent does — in the parent's worktree — unless
         the script asked for `isolation: 'worktree'`: then a checkout of its
         own, so parallel agents editing files cannot collide. */
      worktree: spec.isolation === "worktree" ? true : spec.projectId ? undefined : (parent.worktree ?? undefined),
      suggestKinds: parent.suggestKinds,
      uiGroups: parent.uiGroups,
      /* An ask is the person's go-ahead for its whole brief, and its child has
         nobody in front of it. What no policy can answer still parks, and is
         repeated on the parent (`SessionManager.emit`). */
      ...(ctx.autonomy ? { autonomy: ctx.autonomy } : {}),
    },
  );
}

/** The child of an earlier step or ask, still this parent's, with its process
    back (a step's end retired it; `prompt` never starts one — a revive is its
    own door, the one a send on a retired thread takes). A model change costs a
    respawn too: the same conversation, loaded on the new model. */
async function reviveChild(ctx: StepContext, id: string, model: string | undefined): Promise<Session> {
  const child = ctx.manager.get(id);
  if (!child || child.parentSessionId !== ctx.parent.id) throw new StepConfigError("that step's thread is gone");
  const modelChange = model !== undefined && model !== child.model;
  if (!child.bridge || child.exited || modelChange) {
    const profile = child.profile ?? (await getProfile(child.profileId));
    const project = child.project ?? (await getProject(child.projectId));
    if (!profile || !project) throw new StepConfigError("that step's profile or project no longer exists");
    await ctx.manager.respawn(
      child.id,
      profile,
      child.agentId,
      project,
      model ?? (child.model || undefined),
      child.effort || undefined,
      { revive: true },
    );
  }
  if (!child.bridge || child.exited) throw new StepError("the step's thread could not be revived");
  await child.bridge.ready;
  return child;
}

/** Says the child on the parent, in the exact shape the client's subagent rail
    and workflow card decode. Journaled with the spawn, so a replay redraws it. */
function announce(ctx: StepContext, child: Session, spec: AgentSpec, name: string, rowName: string): void {
  const where = ctx.placement();
  ctx.manager.emitOn(ctx.parent.id, {
    ev: "update",
    seq: 0,
    historyReplay: false,
    update: {
      sessionUpdate: "subagent_spawned",
      subagentSessionId: child.id,
      name: rowName,
      task: firstLine(spec.prompt),
      capabilities: { cancel: true },
      /* `workflow` is what tells the client this subagent is a workflow step —
         and of which run — so a run draws as one card, not N stray rows. `plan`
         is the whole outline, repeated on every spawn so the card shows the
         shape the author wrote from the first step. An ask carries the pair
         instead (`ask`, never `workflow`): it is no run, so it draws as a plain
         subagent — one that has to say it is a *different* agent. A resumed
         child is spawned again: a settled child spawned again is a wake. */
      _meta: {
        daedalus: ctx.ask
          ? {
              ask: {
                agent: ctx.ask.agent,
                profile: ctx.ask.profile,
                agentId: ctx.ask.agentId,
                profileId: ctx.ask.profileId,
              },
            }
          : {
              workflow: {
                runId: ctx.runId,
                sessionId: ctx.parent.id,
                name: ctx.runName,
                step: name,
                title: where.title,
                titles: where.titles,
                index: where.index,
                total: where.total,
                phase: where.phase ?? undefined,
                plan: where.plan,
              },
            },
      },
    },
  });
}

/** Everything the child journals is said again on the parent, addressed to the
    child (the RFD's shape; the reducer files it under the spawn). A grandchild's
    update keeps its own id and nests one level further. The child's own prose
    is also kept: ACP's prompt response carries no text, so the stream is the
    only place a step's answer can be read from. */
function mirror(
  ctx: StepContext,
  child: Session,
  acc: { text: string; bytes: number; outputTokens: number; totalTokens: number; toolUses: number },
): () => void {
  return ctx.manager.subscribe(child.id, (event) => {
    /* What the step's turn cost, said again on the parent. The turn event itself
       is NOT mirrored — a child's turn boundaries on the parent's log would cut
       its replay windows at turns it never had — so the usage is lifted out of
       it onto an update of our own. Per turn, so a step that took a repair turn
       reports twice and the client sums. */
    if (event.ev === "turn_ended" && event.usage) {
      acc.outputTokens += event.usage.outputTokens ?? 0;
      acc.totalTokens += event.usage.totalTokens ?? 0;
      ctx.manager.emitOn(ctx.parent.id, {
        ev: "update",
        seq: 0,
        historyReplay: false,
        update: { sessionUpdate: "_daedalus/subagent_usage", subagentSessionId: child.id, usage: event.usage },
      });
      return;
    }
    if (event.ev !== "update" || event.historyReplay) return;
    ctx.manager.emitOn(ctx.parent.id, { ...event, seq: 0, sessionId: event.sessionId ?? child.id });
    if (event.sessionId) return;
    const u = event.update;
    if (u.sessionUpdate === "tool_call") acc.toolUses += 1;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" && acc.bytes < ENGINE_LIMITS.outputBytes) {
      acc.text += u.content.text;
      acc.bytes += Buffer.byteLength(u.content.text);
    }
  });
}

// ---- one conversation ---------------------------------------------------------

type Settled =
  | { kind: "settled"; error?: TurnOutcome["error"]; interrupted: boolean }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/** The first prompt and, for a JSON reply, at most one repair turn. Returns the
    step's output: the prose, or the validated value. */
async function converse(
  ctx: StepContext,
  child: Session,
  first: string,
  spec: AgentSpec,
  timeoutSec: number | null,
  acc: { text: string; bytes: number },
): Promise<unknown> {
  let next = first;
  for (let turn = 1; ; turn += 1) {
    // Between prompts (the repair turn) as well as before the first: a step does
    // not put a prompt into a held run.
    await ctx.whenRunning();
    acc.text = "";
    acc.bytes = 0;
    const outcome = await promptAndWait(ctx, child, next, timeoutSec);
    if (outcome.kind === "cancelled") throw new StepCancelled("cancelled");
    if (outcome.kind === "timeout") throw new StepError(`timed out after ${timeoutSec}s`);
    if (outcome.error) throw new StepError(outcome.error.message);
    if (outcome.interrupted) throw new StepError("the step's turn was cancelled");
    if (!spec.schema) return acc.text;
    let issue: string;
    try {
      const checked = validateOutput(spec.schema, extractJsonOutput(acc.text));
      if (checked.ok) return checked.value;
      issue = checked.issues;
    } catch (error) {
      issue = error instanceof OutputError ? error.message : describe(error);
    }
    if (turn >= 2) throw new StepError(`the reply did not match the output schema: ${issue}`);
    next = `Your previous reply did not validate against the required JSON schema: ${issue}\nReply with only a single JSON value in a \`\`\`json fence, nothing else.`;
  }
}

/** How long a retry / resume waits for a still-open turn to settle after cancelling it. */
const QUIESCE_MAX_MS = 10_000;

/** A child whose previous turn is still open (a retry after a timeout, a resume at boot that
    picked up a turn the agent kept running) would answer the next prompt with "queued": cancel
    that turn and wait, briefly, for it to settle. */
async function quiesce(ctx: StepContext, child: Session): Promise<void> {
  const bridge = child.bridge;
  if (!bridge?.promptActive) return;
  const turnId = bridge.currentTurnId;
  const settled: Promise<unknown> = turnId ? ctx.manager.whenTurnSettled(child.id, turnId) : bridge.whenIdle();
  settled.catch(NOOP);
  await bridge.cancel().catch(NOOP);
  // Registered after the check above, so re-ask: a turn that ended in between has no one left to settle us.
  if (!bridge.promptActive) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled.catch(NOOP),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIESCE_MAX_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** One prompt to the child and the wait for its turn, raced against the step's
    clock and the run's cancel. */
async function promptAndWait(ctx: StepContext, child: Session, text: string, timeoutSec: number | null): Promise<Settled> {
  if (ctx.signal.aborted) return { kind: "cancelled" };
  await quiesce(ctx, child);
  if (ctx.signal.aborted) return { kind: "cancelled" };
  /* The turn's id is only known once `prompt` answers, and a fast turn can end before that: its
     `turn_ended` is emitted and its waiters settled in one synchronous stretch, so a
     `whenTurnSettled` registered afterwards would wait forever. Listen from before the prompt, and
     if the turn is already over when the waiter is about to be registered, answer from what was heard. */
  const ended = new Map<string, Extract<ThreadEvent, { ev: "turn_ended" }>>();
  const unlisten = ctx.manager.subscribe(child.id, (event) => {
    if (event.ev === "turn_ended") ended.set(event.turnId, event);
  });
  const outcomeOf = (event: Extract<ThreadEvent, { ev: "turn_ended" }>): TurnOutcome => ({
    ...(event.error ? { error: event.error } : {}),
    interrupted: !!event.error,
  });
  let settled: Promise<TurnOutcome>;
  try {
    const reply = await ctx.manager.prompt(child.id, text);
    if (!("turnId" in reply)) throw new StepError("the step's thread was busy"); // quiesce could not clear it
    const early = ended.get(reply.turnId);
    if (early) {
      settled = Promise.resolve(outcomeOf(early));
    } else {
      settled = ctx.manager.whenTurnSettled(child.id, reply.turnId);
      // Registered; if the turn is already over, nothing will ever settle this waiter.
      const again = ended.get(reply.turnId);
      if (again) settled = Promise.resolve(outcomeOf(again));
      else if (!child.bridge?.promptActive) settled = Promise.resolve({ interrupted: false });
    }
  } finally {
    unlisten();
  }
  let timer: { clear(): void } | undefined;
  let onAbort = NOOP;
  const result = await Promise.race<Settled>([
    settled.then((o) => ({ kind: "settled" as const, ...o })),
    new Promise<Settled>((resolve) => {
      if (timeoutSec === null) return;
      // Born held if the run is: a step whose child is being paused right now
      // must not have its clock running while it stands.
      timer = ctx.timer(timeoutSec * 1000, () => resolve({ kind: "timeout" }));
    }),
    new Promise<Settled>((resolve) => {
      onAbort = () => resolve({ kind: "cancelled" });
      // A cancel that landed while `prompt` was still awaiting has fired its
      // event already, and a listener added to an aborted signal never hears it.
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  timer?.clear();
  ctx.signal.removeEventListener("abort", onAbort);
  if (result.kind !== "settled") {
    // The turn is still open in the child; ask it to stop before the retire that
    // follows kills it, so its own log ends on a cancel, not a crash.
    await child.bridge?.cancel().catch(NOOP);
    settled.catch(NOOP);
  }
  return result;
}

/** A backoff that stands still while the run is paused; false when the run is cancelled. */
function pausableSleep(ctx: StepContext, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (ctx.signal.aborted) return resolve(false);
    let onAbort = NOOP;
    const timer = ctx.timer(ms, () => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(true);
    });
    onAbort = () => {
      timer.clear();
      resolve(false);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}


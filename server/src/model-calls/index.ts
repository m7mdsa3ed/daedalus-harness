/* ── The one server door for every model-call source ──
 *
 * A thread has one door for its life (`chooseDoor`): at spawn, the first entry
 * of its runtime's `callsVia` whose source attaches is the thread's, and the
 * rest are not tried. The implicit last door is `usage` — the runtime's own
 * `usage_update`, billed only. **That choice is the double-count guard**: a
 * `usage_update` rows only on a thread whose door is `usage`.
 *
 * Every door hands a draft to `recordCall`, which counts and anchors the parts
 * and emits the record onto the thread as `_daedalus/model_call`; the thread's
 * `emit` then files it (`fileCall`) — fills `step` and the open turn from the
 * bridge, writes the ledger row — on the same path a record the runtime sent
 * itself takes, so the two stores are written once each and nothing downstream
 * can tell who built a record. A source never touches the bridge, the journal
 * or the database: it sees a `CallThread`.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type * as acp from "../acp.js";
import { db, modelCalls } from "../db/index.js";
import type { CallDoor, CallsVia, ModelCall, ModelCallUpdate, SessionUpdate } from "../protocol.js";
import { countShape, partsOf, type RequestShape } from "./prompt-parts.js";
import { acpSource } from "./sources/acp.js";
import { filesSource } from "./sources/files.js";
import { otlpSource } from "./sources/otlp.js";
import { proxySource } from "./sources/proxy.js";

/** What a source may know about the thread it attaches to — readings, never
    the bridge or the row. Built by `SessionManager.callThreadOf`. */
export interface CallThread {
  readonly id: string;
  readonly agentId: string;
  readonly profileId: string;
  readonly projectId: string;
  /** Where the agent runs (its worktree when it has one). */
  readonly cwd: string;
  /** Behind the gateway shim — what the `proxy` door needs. */
  readonly viaGateway: boolean;
  /** The agent's own session id, once *proven* (`acp_session` earned), else
      null — what the `files` door waits for. Read, never captured: it moves. */
  acpSessionId(): string | null;
  /** The turn open on the bridge, and the next step number in it. */
  /** The turn a request sent at `at` belongs to: the open one, else the one
      that ended after it began (a late-reporting door), else none. */
  turn(at: number): { turnId: string | null; nextStep(): number };
  /** Snapshot names for the ledger, as `web_search_usage` keeps them. */
  names(): { threadTitle: string; profileName: string; projectName: string };
  /** Put a record on the wire: journaled and fanned out, then filed. */
  emit(update: ModelCallUpdate): void;
}

export interface Attached {
  /** Env the spawn merges over the resolved template (the `otlp` switches). */
  spawnEnv?: Record<string, string>;
  /** The process is gone or respawning; stop watching. */
  stop(): void;
}

export interface CallSource {
  readonly kind: CallDoor["kind"];
  /** Null = this door is not open for this thread; the next is tried. */
  attach(thread: CallThread, door: CallDoor): Promise<Attached | null>;
}

/** The registry of sources by kind. A fifth door is an entry here, a union
    member in protocol.ts and a seed in registry.ts — nothing else. */
export const sources: Record<CallDoor["kind"], CallSource> = {
  acp: acpSource,
  otlp: otlpSource,
  proxy: proxySource,
  files: filesSource,
};

export interface ChosenDoor {
  kind: CallsVia;
  attached: Attached | null;
}

/** The first door in `doors` that attaches, else `usage`. A source that throws
    is a source that did not attach. */
export async function chooseDoor(thread: CallThread, doors: readonly CallDoor[]): Promise<ChosenDoor> {
  for (const door of doors) {
    const source = sources[door.kind];
    if (!source) continue;
    const attached = await source.attach(thread, door).catch((error: unknown) => {
      console.warn(`[model-calls] ${door.kind} did not attach to ${thread.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (attached) return { kind: door.kind, attached };
  }
  return { kind: "usage", attached: null };
}

/** What a source hands over: the record less what the door fills (`step`, the
    anchored parts). `shape` is the request as the door saw it, counted here. */
export type ModelCallDraft = Omit<ModelCall, "step" | "prompt" | "missing" | "items"> & {
  step?: number;
  shape?: RequestShape;
  /** Send `items` with this record (the prefix changed); off by default. */
  items?: boolean;
};

export const billedPrompt = (billed: acp.Usage): number =>
  billed.inputTokens + (billed.cachedReadTokens ?? 0) + (billed.cachedWriteTokens ?? 0);

/** Count, anchor, emit. Filing (step, turn, the ledger) happens where the
    emitted update lands — `fileCall`, from the thread's `emit`. */
export async function recordCall(thread: CallThread, draft: ModelCallDraft): Promise<void> {
  const { shape, items: wantItems, ...rest } = draft;
  const call: ModelCall = { ...rest, step: draft.step ?? 0 };
  /* A prompt seen with no bill (an OTLP body whose request never paired) has
     nothing to be a share of: anchoring it to zero drew a row of zeros. */
  if (shape && billedPrompt(call.billed) === 0) return;
  if (shape) {
    const parts = partsOf(billedPrompt(call.billed), await countShape(shape));
    call.prompt = parts.prompt;
    if (parts.missing) call.missing = parts.missing;
    if (wantItems) call.items = parts.items;
    if (parts.toolUse) call.toolUse = parts.toolUse;
  }
  thread.emit({ sessionUpdate: "_daedalus/model_call", call });
}

/** The implicit last door. A draft out of a `usage_update`, only on a thread
    whose door is `usage` — the double-count guard — and only when the update
    carries a bill. Our runtime says the step's under `_meta.daedalus.step`; the
    other runtimes put the last request's count in `used` and nothing beside it,
    so for them the bill is one undivided number.
    ponytail: claude-agent-acp reports a request twice (opening and closing) —
    a `usage` thread of it rows twice a step; the client dedupes by tail
    movement, the ledger cannot. Its own doors (otlp, proxy, files) outrank this. */
export function usageFallback(door: ChosenDoor, model: string, update: SessionUpdate): ModelCallDraft | null {
  if (door.kind !== "usage" || update.sessionUpdate !== "usage_update") return null;
  const step = (update._meta?.daedalus as { step?: acp.Usage } | undefined)?.step;
  const billed: acp.Usage | null = step
    ? step
    : typeof update.used === "number" && update.used > 0
      ? { totalTokens: update.used, inputTokens: update.used, outputTokens: 0 }
      : null;
  if (!billed) return null;
  return { callId: randomUUID(), at: Date.now(), who: "turn", model, source: "usage", billed };
}

/**
 * File a record that is on the wire: fill `step` where the source left it (0)
 * and write the ledger row. Called from the thread's `emit` for every live
 * `_daedalus/model_call`, whoever built it — mutates the record *before* the
 * journal writes it, so the replay carries the same step the ledger does.
 */
export function fileCall(thread: CallThread, call: ModelCall): Promise<void> {
  const turn = thread.turn(call.at);
  if (!call.step) call.step = turn.nextStep();
  const names = thread.names();
  return db
    .insert(modelCalls)
    .values({
      id: randomUUID(),
      sessionId: thread.id,
      turnId: turn.turnId,
      callId: call.callId,
      at: call.at,
      ms: call.ms ?? null,
      who: call.who,
      childId: call.childId ?? null,
      step: call.step,
      agentId: thread.agentId,
      model: call.model,
      finishReason: call.finishReason ?? null,
      source: call.source,
      inputTokens: call.billed.inputTokens,
      outputTokens: call.billed.outputTokens,
      cacheReadTokens: call.billed.cachedReadTokens ?? null,
      cacheWriteTokens: call.billed.cachedWriteTokens ?? null,
      thoughtTokens: call.billed.thoughtTokens ?? null,
      costUsd: call.costUsd ?? null,
      promptSystem: call.prompt?.system ?? null,
      promptTools: call.prompt?.tools ?? null,
      promptMcp: call.prompt?.mcp ?? null,
      promptUser: call.prompt?.user ?? null,
      promptAssistant: call.prompt?.assistant ?? null,
      promptResults: call.prompt?.results ?? null,
      promptUnknown: call.prompt?.unknown ?? null,
      missing: call.missing ?? null,
      outputText: call.output?.text ?? null,
      outputReasoning: call.output?.reasoning ?? null,
      outputToolCalls: call.output?.toolCalls ?? null,
      toolUse: call.toolUse ?? null,
      called: call.called ?? null,
      profileId: thread.profileId,
      projectId: thread.projectId,
      ...names,
    })
    .then(() => undefined);
}

/* ── reading the ledger ── */

type Row = typeof modelCalls.$inferSelect;

/** A ledger row back in the record's shape, with the turn it was filed under. */
function callOf(row: Row): ModelCall & { turnId: string | null } {
  const prompt =
    row.promptUnknown === null
      ? undefined
      : {
          system: row.promptSystem,
          tools: row.promptTools,
          mcp: row.promptMcp,
          user: row.promptUser,
          assistant: row.promptAssistant,
          results: row.promptResults,
          unknown: row.promptUnknown,
        };
  return {
    turnId: row.turnId,
    callId: row.callId,
    at: row.at,
    ...(row.ms !== null ? { ms: row.ms } : {}),
    who: row.who as ModelCall["who"],
    ...(row.childId ? { childId: row.childId } : {}),
    step: row.step,
    model: row.model,
    ...(row.finishReason ? { finishReason: row.finishReason } : {}),
    source: row.source as ModelCall["source"],
    billed: {
      totalTokens: row.inputTokens + row.outputTokens + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedReadTokens: row.cacheReadTokens,
      cachedWriteTokens: row.cacheWriteTokens,
      thoughtTokens: row.thoughtTokens,
    },
    ...(row.costUsd !== null ? { costUsd: row.costUsd } : {}),
    ...(prompt ? { prompt } : {}),
    ...(row.missing ? { missing: row.missing } : {}),
    ...(row.outputText !== null
      ? { output: { text: row.outputText, reasoning: row.outputReasoning ?? 0, toolCalls: row.outputToolCalls ?? 0 } }
      : {}),
    ...(row.toolUse ? { toolUse: row.toolUse } : {}),
    ...(row.called ? { called: row.called } : {}),
  };
}

/** A thread's calls, newest first, paged by `at` (`before` = the oldest `at`
    the caller holds). The panel's cold read; the live ones ride the journal. */
export async function listCalls(sessionId: string, opts: { before?: number; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const where = opts.before ? and(eq(modelCalls.sessionId, sessionId), lt(modelCalls.at, opts.before)) : eq(modelCalls.sessionId, sessionId);
  const rows = await db.select().from(modelCalls).where(where).orderBy(desc(modelCalls.at)).limit(limit);
  return rows.map(callOf);
}

export const SPEND_GROUPS = ["profile", "model", "project", "agent", "source"] as const;
export type SpendGroupBy = (typeof SPEND_GROUPS)[number];

const GROUP_KEY = {
  profile: modelCalls.profileId,
  model: modelCalls.model,
  project: modelCalls.projectId,
  agent: modelCalls.agentId,
  source: modelCalls.source,
} as const;
const GROUP_NAME = {
  profile: modelCalls.profileName,
  model: modelCalls.model,
  project: modelCalls.projectName,
  agent: modelCalls.agentId,
  source: modelCalls.source,
} as const;

/** The Spend tab: billed sums over `[from, to]` by one of the five keys. `name`
    is the snapshot taken when the row was written (the newest one wins). */
export async function spendBy(groupBy: SpendGroupBy, from?: number, to?: number) {
  const bounds = [from !== undefined ? gte(modelCalls.at, from) : undefined, to !== undefined ? lte(modelCalls.at, to) : undefined].filter(Boolean);
  const key = GROUP_KEY[groupBy];
  const rows = await db
    .select({
      key,
      name: sql<string>`max(${GROUP_NAME[groupBy]})`,
      calls: sql<number>`count(*)::int`,
      input: sql<number>`sum(${modelCalls.inputTokens})::bigint`,
      cacheRead: sql<number>`coalesce(sum(${modelCalls.cacheReadTokens}), 0)::bigint`,
      cacheWrite: sql<number>`coalesce(sum(${modelCalls.cacheWriteTokens}), 0)::bigint`,
      output: sql<number>`sum(${modelCalls.outputTokens})::bigint`,
      reasoning: sql<number>`coalesce(sum(${modelCalls.thoughtTokens}), 0)::bigint`,
      costUsd: sql<number | null>`sum(${modelCalls.costUsd})`,
    })
    .from(modelCalls)
    .where(bounds.length ? and(...bounds) : undefined)
    .groupBy(key)
    .orderBy(desc(sql`sum(${modelCalls.inputTokens} + ${modelCalls.outputTokens})`));
  /* node-postgres hands bigint sums back as strings. */
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    calls: Number(r.calls),
    input: Number(r.input),
    cacheRead: Number(r.cacheRead),
    cacheWrite: Number(r.cacheWrite),
    output: Number(r.output),
    reasoning: Number(r.reasoning),
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
  }));
}

/** Drop ledger rows older than `cutoff` (epoch ms), on the journal's sweep. */
export async function pruneModelCalls(cutoff: number): Promise<number> {
  return (await db.delete(modelCalls).where(lt(modelCalls.at, cutoff))).rowCount ?? 0;
}

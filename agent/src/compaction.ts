import { randomUUID } from "node:crypto";
import type * as acp from "./acp.js";
import { streamText, type ModelMessage } from "ai";
import type { AgentEnv } from "./env.js";
import type { ModelFactory } from "./provider.js";
import type { Session } from "./session.js";
import type { Emitter } from "./updates.js";
import type { CallHooks } from "./trace.js";
import { cacheAffinity } from "./provider.js";

/**
 * The harness's own compaction trigger, spelled the same in
 * `server/src/acp-bridge.ts`. ACP reports compaction — `compaction_update` and
 * `compaction_summary_chunk` are in the schema — but it has no way for a client
 * to *ask* for one: the agent decides. This runtime owns its loop, so it can
 * summarize on request as well as on a threshold, and the harness reads the
 * capability to offer the button.
 *
 * Named here rather than in `hold.ts` because compaction is not a hold: the two
 * meet only in that a held turn is the most useful moment to ask for one
 * ("compact and continue" — the second button `app.ts`'s resume comment
 * anticipated). `turn.ts` reads the flag and `app.ts` serves the method, and
 * both already import this module, so there is no cycle to avoid.
 */
export const COMPACT_METHOD = "_daedalus/session/compact";
export const COMPACT_CAPABILITY = "daedalus/compact";

export interface CompactResponse {
  /** True when the summary is already in place — the between-turns door. */
  compacted: boolean;
  /** True when a turn was running and the request was booked for its next step
      boundary, which is the only place a turn can be summarized without losing
      the step in flight. The `compaction_update` stream says when it lands. */
  deferred: boolean;
  turnActive: boolean;
}

const FALLBACK_WINDOW = 200_000;
const THRESHOLD = 0.8;
/* A summary is a page, not a transcript — and an uncapped summarizer pointed
   at a near-full window can run away on the very request meant to shrink it. */
const MAX_SUMMARY_TOKENS = 8_192;

const SUMMARY_PROMPT =
  "Summarize this conversation so it can continue in a fresh context. Keep: the user's goal and constraints, decisions made, files touched and how, current state of the work, and what remains. Be specific about paths and names. Write the summary and nothing else.";

/** What the window is for the model a request is actually going out on. */
export interface ContextWindow {
  /** The model's full context window — what `usage_update.size` reports, and
      what a reader means by "a 200k model". */
  size: number;
  /** What a *prompt* may occupy: the window less the room the answer needs.
      The threshold reads this one. Thresholding against the full window let a
      64k-output model on a 200k window sail to 160k of prompt, at which point
      the request that trips the threshold is the one that already failed. */
  usable: number;
  /** False when nothing in the catalog knew this model and `size` is
      `FALLBACK_WINDOW` — a fabricated denominator that a percentage, a
      "remaining" figure and a compaction warning would all otherwise wear as
      fact. Travels on `_meta` so the client can draw the reading as an
      estimate; compaction still runs on it, because a guessed ceiling is a
      better bargain than none. */
  known: boolean;
}

/**
 * Resolved per request rather than per spawn, because the model is a live
 * setting and the window is a property of the model — see `AgentEnv.modelWindows`.
 */
export function windowFor(env: AgentEnv, modelId: string | null): ContextWindow {
  const pair = modelId ? env.modelWindows[modelId] : undefined;
  /* The spawn model's own figures stand in for a model the map does not name —
     which is every model when the harness is not the spawner (a hand-run agent
     gets whatever `DAEDALUS_AGENT_CONTEXT_WINDOW` it was given, as before). */
  const size = pair?.[0] ?? env.contextWindow ?? FALLBACK_WINDOW;
  const maxOutput = pair ? pair[1] : (env.maxOutputTokens ?? 0);
  return {
    size,
    /* Floored well above zero: a catalog that reports an output cap as large as
       the window itself would otherwise make every turn need compacting. */
    usable: Math.max(size * 0.5, size - maxOutput),
    known: pair !== undefined || env.contextWindow !== null,
  };
}

export function needsCompaction(session: Session, env: AgentEnv): boolean {
  return (
    session.autoCompact && session.lastTokens > THRESHOLD * windowFor(env, session.modelId).usable
  );
}

/* Runs between turns, when the last request's own token reading crossed the
   threshold. The updates are gated on the client's `session.compaction` claim
   (an unclaimed capability is a feature kept quiet, per ACP); the compaction
   itself is not — running out of window is not negotiable. */
export async function compact(
  session: Session,
  env: AgentEnv,
  makeModel: ModelFactory,
  emit: Emitter,
  announce: boolean,
  signal: AbortSignal,
  /** The summarizer's own call, metered and traced into the turn that asked for it. */
  hooks?: CallHooks,
): Promise<void> {
  const compactionId = randomUUID();
  const say = async (update: acp.SessionUpdate) => {
    if (announce) await emit.update(update);
  };
  await say({ sessionUpdate: "compaction_update", compactionId, status: "in_progress" });
  try {
    const result = streamText({
      model: makeModel(env, env.smallModel || session.modelId),
      system: "You summarize agent coding sessions faithfully and concisely.",
      messages: [...session.messages, { role: "user", content: SUMMARY_PROMPT }],
      abortSignal: signal,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
      ...hooks,
      /* The turn's own affinity key: a summarizer that lands on another
         backend re-sends the whole history uncached, which is the most
         expensive request a session makes. */
      providerOptions: cacheAffinity(env, session.id),
    });
    let summary = "";
    for await (const text of result.textStream) {
      summary += text;
      await say({
        sessionUpdate: "compaction_summary_chunk",
        compactionId,
        content: { type: "text", text },
      });
    }
    /* An empty summary is a failed compaction, not a licence to wipe the
       history — replacing the messages with it would lose the session. */
    if (!summary.trim()) throw new Error("summarizer returned an empty summary");
    const replacement: ModelMessage = {
      role: "user",
      content: `Summary of the conversation so far (earlier messages were compacted):\n\n${summary}`,
    };
    session.messages = [replacement];
    session.lastTokens = 0;
    emit.storeCompaction(replacement);
    await say({ sessionUpdate: "compaction_update", compactionId, status: "completed" });
  } catch (err) {
    await say({
      sessionUpdate: "compaction_update",
      compactionId,
      status: "failed",
      error: (err as Error).message,
    });
    /* Rethrown for the caller to triage: the turn proceeds uncompacted unless
       the failure was its own abort. */
    throw err;
  }
}

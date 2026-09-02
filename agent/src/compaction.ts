import { randomUUID } from "node:crypto";
import type * as acp from "./acp.js";
import { streamText, type ModelMessage } from "ai";
import type { AgentEnv } from "./env.js";
import type { ModelFactory } from "./provider.js";
import type { Session } from "./session.js";
import type { Emitter } from "./updates.js";

const FALLBACK_WINDOW = 200_000;
const THRESHOLD = 0.8;
/* A summary is a page, not a transcript — and an uncapped summarizer pointed
   at a near-full window can run away on the very request meant to shrink it. */
const MAX_SUMMARY_TOKENS = 8_192;

const SUMMARY_PROMPT =
  "Summarize this conversation so it can continue in a fresh context. Keep: the user's goal and constraints, decisions made, files touched and how, current state of the work, and what remains. Be specific about paths and names. Write the summary and nothing else.";

export function windowSize(env: AgentEnv): number {
  return env.contextWindow ?? FALLBACK_WINDOW;
}

export function needsCompaction(session: Session, env: AgentEnv): boolean {
  return session.autoCompact && session.lastTokens > THRESHOLD * windowSize(env);
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

import type * as acp from "@daedalus/acp"
import { mintItemId } from "./items"
import type { TextItem, ThreadItem } from "./items"

export function pushUserMessage(
  items: ThreadItem[],
  text: string,
  at?: number,
  turnId?: string,
  local?: boolean,
  attachments?: TextItem["attachments"]
): ThreadItem[] {
  return [
    ...items,
    {
      kind: "user",
      id: mintItemId("user"),
      text,
      at,
      turnId,
      local,
      ...(attachments?.length ? { attachments } : {}),
    },
  ]
}

/** null only when neither side reported the field — keeps optional stats hidden. */
const addOptional = (a: number | null | undefined, b: number | null | undefined) =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0)

/**
 * ACP's Usage doc-comments claim session totals, but agents send per-turn
 * numbers (observed: totalTokens falling between turns), so the running total
 * is ours to keep — and an average cache rate needs it.
 *
 * Both callers fold a `turn_ended`, and nothing else may: the thread's own, and
 * a workflow step's, which the runner lifts off the child's settled turn and
 * says again as `_daedalus/subagent_usage` (see the protocol). Each of those is
 * journaled exactly once per turn, live and on replay alike, so neither total
 * can count a turn twice.
 */
export function addUsage(prev: acp.Usage | null, next: acp.Usage): acp.Usage {
  if (!prev) return next
  return {
    totalTokens: prev.totalTokens + next.totalTokens,
    inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    thoughtTokens: addOptional(prev.thoughtTokens, next.thoughtTokens),
    cachedReadTokens: addOptional(prev.cachedReadTokens, next.cachedReadTokens),
    cachedWriteTokens: addOptional(prev.cachedWriteTokens, next.cachedWriteTokens),
  }
}

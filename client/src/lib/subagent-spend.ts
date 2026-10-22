/* ── What a thread's children spent ── */
import type * as acp from "@daedalus/acp"

import type { ThreadItem } from "@/lib/store/items"
import { formatDuration } from "@/lib/tokens"

/** One child's spend: a subagent session or a background task/workflow run. */
export interface SubagentSpend {
  id: string
  name: string
  tokens: number
  /** The full billed split, when the child's runtime reported one — an async
      task's totals are a single figure. */
  usage?: acp.Usage
  workflow: boolean
  /** Time spent running, settled turns only; absent while unmeasured. */
  durationMs?: number
  running: boolean
}

/** What every child of the thread billed, biggest first. A `subagent` row and
    an `async-task` row never describe the same child (a native workflow's
    steps are synthesized at view time, not stored), so their sum is honest.
    ponytail: attribution only — whether a child's tokens are also inside the
    parent's turn total is the runtime's choice (our `task` tool bills its
    children to the parent; a workflow step is its own session), so callers
    never add this to the thread total. */
export function subagentSpend(items: ThreadItem[]): SubagentSpend[] {
  const out: SubagentSpend[] = []
  for (const item of items) {
    if (item.kind === "subagent" && item.usage) {
      out.push({
        id: item.id,
        name: item.name,
        tokens: item.usage.totalTokens,
        usage: item.usage,
        workflow: !!item.workflow,
        durationMs: item.durationMs,
        running: item.state === "running",
      })
    } else if (item.kind === "async-task" && item.usage?.totalTokens) {
      out.push({
        id: item.id,
        name: item.description || item.name,
        tokens: item.usage.totalTokens,
        workflow: true,
        durationMs: item.usage.durationMs || undefined,
        running: item.state === "running",
      })
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

/** A child's time as one short phrase: "running", its measured time, or
    nothing when the runtime gave us no way to tell. */
export function spendTime(child: SubagentSpend): string | undefined {
  if (child.running) return "running"
  return child.durationMs ? formatDuration(child.durationMs) : undefined
}

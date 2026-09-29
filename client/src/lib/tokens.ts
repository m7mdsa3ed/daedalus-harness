/* ── Token figures ──
   How a token count is written, in the one place every surface that prints one
   reads it from: the composer's stats popover, a turn's footer, a workflow
   step, a subagent's row. They used to agree by coincidence — the popover kept
   its own formatter — and a thousand tokens reading `1.0k` in one place and
   `1000` in another is the kind of difference a reader has to stop and resolve.

   Nothing here is a component: a *figure* is shared, the layout that holds it
   is not (a step row's trailing column and a popover's `<dl>` are not the same
   thing). See `components/token-usage.tsx` for the drawn forms. */
import type * as acp from "@daedalus/acp"

import type { ThreadItem } from "@/lib/store/items"
import { vendorMeta } from "@/lib/tools"

/**
 * Whether the window this reading is a fraction of was measured or guessed.
 *
 * ACP's `size` is a required number with no way to say "unknown", so a runtime
 * that has no catalog entry for the model it is on has to report *something* —
 * and a fabricated denominator turns a percentage, a "remaining" figure and a
 * compaction warning into three confident lies. Our own runtime says so beside
 * the figure instead (`agent/src/compaction.ts`, `ContextWindow.known`); a
 * runtime that says nothing is taken at its word, which is the only thing that
 * can be done with it.
 */
export function windowEstimated(usage: acp.UsageUpdate | null | undefined): boolean {
  return vendorMeta(usage?._meta, "daedalus")?.windowEstimated === true
}

/**
 * How a request's prompt divided, when our own runtime measured it.
 *
 * A provider bills one `prompt_tokens` and says nothing about what was in it, so
 * the split is our runtime's own (`agent/src/token-breakdown.ts`): the system
 * prompt and the tool block are counted locally, and everything left over —
 * the history, this turn's message, every tool result — is the conversation.
 * `total` and `conversation` are the provider's exact arithmetic; `system` and
 * `tools` are the estimate, which is why every surface that draws them says so.
 *
 * Absent for any runtime that does not measure it, which is every one but ours —
 * the caller draws nothing rather than a row of zeros.
 */
export interface PromptBreakdown {
  total: number
  system: number
  /** Built-in tools only; MCP servers' tools are `mcp`. */
  tools: number
  /** 0 on a step journaled before the MCP share was counted apart — those
      carried it inside `tools`. */
  mcp: number
  /** Locally estimated tokens in user-role messages, null on older events. */
  user: number | null
  /** History and tool results after user messages are separated. */
  conversation: number
}

export function promptBreakdown(
  usage: acp.UsageUpdate | null | undefined
): PromptBreakdown | null {
  const raw = vendorMeta(usage?._meta, "daedalus")?.breakdown
  if (raw === null || typeof raw !== "object") return null
  const { total, system, tools, mcp, user, conversation } = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const [t, s, tl, c] = [num(total), num(system), num(tools), num(conversation)]
  return t === null || s === null || tl === null || c === null
    ? null
    : { total: t, system: s, tools: tl, mcp: num(mcp) ?? 0, user: num(user), conversation: c }
}

/** One model request's own bill (`_meta.daedalus.step`, our runtime only) —
    its output and reasoning, which the `used` total folds together. */
export function stepBill(usage: acp.UsageUpdate | null | undefined): acp.Usage | null {
  const step = vendorMeta(usage?._meta, "daedalus")?.step as acp.Usage | undefined
  return step && typeof step.outputTokens === "number" ? step : null
}

export interface TurnTokens {
  /** The user row that opened the turn. */
  id: string
  prompt: string
  /** What the runtime billed for the whole turn, once it ended. */
  usage?: acp.Usage
  /** Each model request in it, in order, as `markStepUsage` filed them. */
  steps: acp.UsageUpdate[]
}

/** The thread's tokens, turn by turn: the same nearest-user-row walk that
    `withStepTurnUsage` does, collecting the step readings filed on the way.
    A subagent's rows are skipped — their requests are the child's. */
export function tokensByTurn(
  items: ThreadItem[],
  stepUsage: Record<string, acp.UsageUpdate>,
  turnUsage: Record<string, acp.Usage>
): TurnTokens[] {
  const turns: TurnTokens[] = []
  for (const item of items) {
    if (item.parentId) continue
    if (item.kind === "user") {
      turns.push({ id: item.id, prompt: item.text, usage: item.turnId ? turnUsage[item.turnId] : undefined, steps: [] })
    }
    const step = stepUsage[item.id]
    if (step) turns.at(-1)?.steps.push(step)
  }
  return turns.filter((turn) => turn.usage || turn.steps.length > 0)
}

/** `842`, `12.4k`, `1.3M` — three significant-ish digits at every scale, so a
    column of them stays the same width. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** What a reader means by "the prompt": everything sent up, cache hits and the
    writes that filled the cache included. `inputTokens` alone is only the part
    the provider had to read fresh, which understates a cached turn enormously. */
export function promptTokens(usage: acp.Usage): number {
  return usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0)
}

/** `42.1 tok/s`, `842 tok/s` — one decimal below a hundred, whole above it,
    so a column of them stays readable. `null` when there is nothing to divide
    by: no output tokens, or no measured duration. */
export function formatRate(outputTokens: number, durationMs: number): string | null {
  if (!(outputTokens > 0) || !(durationMs > 0)) return null
  return formatTps((outputTokens * 1000) / durationMs)
}

export function formatTps(perSec: number): string | null {
  if (!(perSec > 0) || !Number.isFinite(perSec)) return null
  return `${perSec >= 100 ? Math.round(perSec).toString() : perSec.toFixed(1)} tok/s`
}

/** `12s`, `2m 3s` — how long a turn took, for the footer beside its speed. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Total across several readings — a workflow run's steps, say. `null` when
    none of them reported anything, which is not the same as zero: an agent
    that does not meter tokens must not be drawn as having spent none. */
export function sumUsage(parts: (acp.Usage | null | undefined)[]): acp.Usage | null {
  let total: acp.Usage | null = null
  for (const part of parts) {
    if (!part) continue
    total = total
      ? {
          totalTokens: total.totalTokens + part.totalTokens,
          inputTokens: total.inputTokens + part.inputTokens,
          outputTokens: total.outputTokens + part.outputTokens,
          thoughtTokens: addOptional(total.thoughtTokens, part.thoughtTokens),
          cachedReadTokens: addOptional(total.cachedReadTokens, part.cachedReadTokens),
          cachedWriteTokens: addOptional(total.cachedWriteTokens, part.cachedWriteTokens),
        }
      : part
  }
  return total
}

/** null only when neither side reported the field — keeps optional stats
    hidden rather than printing a zero nobody measured. */
const addOptional = (a: number | null | undefined, b: number | null | undefined) =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0)

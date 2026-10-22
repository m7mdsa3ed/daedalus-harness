/**
 * Which calls of a run were one request's parallel batch, and how long the
 * agent sat between one batch and the next.
 *
 * Pure, like `tool-graph.ts`. Two sources of evidence, in this order:
 *
 * 1. **The runtime's own word** — a step id (`_meta.daedalus.stepId`, one per
 *    model request, read through `lib/tools`). Two neighbouring calls with ids
 *    are one batch exactly when the ids are equal. Nothing is guessed.
 * 2. **Timing**, for a runtime that does not send one (and a journal written
 *    before it did). ACP says nothing about which calls shared a response, but
 *    they arrive as one burst — within milliseconds of each other — or overlap
 *    while they run. A call joins the batch when it starts inside the burst
 *    window or before the batch's latest call has ended.
 *
 * Steps with neither (notices, a replayed `session/load`) never join, so a
 * transcript without evidence marks nothing rather than guessing.
 */
import type { StepSpan } from "@/lib/tool-graph"

/** How close together calls must be announced to count as one response — only
    read for a call with no step id. A choice of presets, not a free number:
    the page draws a Segmented, and a stored value outside the list is dropped. */
export const BATCH_BURSTS = [
  { id: "100ms", ms: 100, label: "100 ms" },
  { id: "250ms", ms: 250, label: "250 ms" },
  { id: "1s", ms: 1000, label: "1 s" },
] as const
export type BatchBurst = (typeof BATCH_BURSTS)[number]["id"]

/** The shortest wait between batches worth saying. `null` is Off. */
export const GAP_MINS = [
  { id: "off", ms: null, label: "Off" },
  { id: "1s", ms: 1000, label: "1 s" },
  { id: "3s", ms: 3000, label: "3 s" },
  { id: "10s", ms: 10_000, label: "10 s" },
] as const
export type GapMin = (typeof GAP_MINS)[number]["id"]

export const isBatchBurst = (value: unknown): value is BatchBurst =>
  BATCH_BURSTS.some((entry) => entry.id === value)
export const isGapMin = (value: unknown): value is GapMin => GAP_MINS.some((entry) => entry.id === value)

/** The preset's milliseconds; the default's for a value that is not one, since
    this is read on every render and must never throw. */
export const burstMs = (id: BatchBurst): number => (BATCH_BURSTS.find((entry) => entry.id === id) ?? BATCH_BURSTS[1]).ms
export const gapMinMs = (id: GapMin): number | null => (GAP_MINS.find((entry) => entry.id === id) ?? GAP_MINS[1]).ms

export interface BatchSpan extends StepSpan {
  /** The runtime's id for the model request that made this call. */
  step?: string
}

export interface BatchOptions {
  burstMs: number
  /** `null` draws no waits. */
  gapMinMs: number | null
}

export interface StepBatch {
  /** 1-based place in its batch; absent for a call that ran alone. */
  index?: number
  /** Calls in its batch; absent for a call that ran alone. */
  size?: number
  /** Where this row sits on its batch's bracket: its first call, its last, or
      anything between — a notice between two calls of one response included,
      which has no `index` but is still inside the bracket. */
  edge?: "start" | "middle" | "end"
  /** Ms between the end of this call's batch and the start of the next batch,
      on the batch's last call only, and only past the threshold. */
  gapMs?: number
  /** Ms from the batch's first call starting to its latest ending — what the
      calls cost together, since they ran side by side. On the batch's last call
      only, and only once every call has ended. */
  spanMs?: number
}

export function layoutBatches(spans: readonly BatchSpan[], options: BatchOptions): StepBatch[] {
  const out: StepBatch[] = spans.map(() => ({}))
  const batches: { members: number[]; start: number; end: number; step?: string }[] = []

  spans.forEach((span, i) => {
    if (span.start === undefined) return
    const last = batches[batches.length - 1]
    const sameStep =
      last && span.step !== undefined && last.step !== undefined ? span.step === last.step : undefined
    const joins =
      last && (sameStep ?? (span.start - last.start <= options.burstMs || span.start < last.end))
    if (last && joins) {
      last.members.push(i)
      last.end = Math.max(last.end, span.end ?? Infinity)
    } else {
      batches.push({ members: [i], start: span.start, end: span.end ?? Infinity, step: span.step })
    }
  })

  batches.forEach((batch, b) => {
    const size = batch.members.length
    if (size > 1) {
      batch.members.forEach((i, k) => Object.assign(out[i], { index: k + 1, size }))
      const first = batch.members[0]
      const last = batch.members[size - 1]
      for (let i = first; i <= last; i++) out[i].edge = i === first ? "start" : i === last ? "end" : "middle"
      if (Number.isFinite(batch.end)) out[last].spanMs = Math.max(0, batch.end - batch.start)
    }
    const next = batches[b + 1]
    if (options.gapMinMs === null || !next || !Number.isFinite(batch.end)) return
    const gap = next.start - batch.end
    if (gap >= options.gapMinMs) out[batch.members[size - 1]].gapMs = gap
  })
  return out
}

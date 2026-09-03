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
  const perSec = (outputTokens * 1000) / durationMs
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

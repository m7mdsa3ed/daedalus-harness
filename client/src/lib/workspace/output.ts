/* ── Output ──
   One buffer per project, and Problems is a *view* of it.

   That is the whole design decision. A problem is an output record that parsed
   into a location — a compiler's diagnostics are its output, read more closely,
   not a separate stream from somewhere else. Keeping them as one buffer means
   the raw text and the structured list cannot disagree, and there is one cap,
   one search and one clear rather than two of each.

   Runtime-only and device-local, in the same reactive shape as `pins.ts` and
   `task-events.ts`. Nothing here is persisted: the sources are the server's
   (agent stderr, task journals), so a reload re-reads them rather than
   restoring a stale copy. */
import * as React from "react"

export interface OutputLocation {
  /** Project-relative where it could be made so; otherwise as reported. */
  relativePath: string
  line: number
  column?: number
  severity: "error" | "warning" | "info"
}

export interface OutputRecord {
  id: string
  projectId: string
  /** Where it came from, shown as a label and used by the filter. */
  source: string
  message: string
  at: number
  /** Present iff this record is also a "problem". */
  location?: OutputLocation
}

/** Records kept per project. Past this the oldest go, and it says so. */
const MAX_RECORDS = 5000

const buffers = new Map<string, OutputRecord[]>()
const listeners = new Set<() => void>()
const EMPTY: OutputRecord[] = []
let sequence = 0

function notify(): void {
  for (const listener of listeners) listener()
}

/* ── Location parsing ──────────────────────────────────────────────────────── */

const SEVERITY = /\b(error|warn(?:ing)?|info|note)\b/i

const PATTERNS: RegExp[] = [
  // tsc: `src/x.ts(12,34): error TS2304: msg`
  /^\s*(?<path>[^\s()]+)\((?<line>\d+),(?<column>\d+)\)\s*:\s*(?<rest>.*)$/,
  // eslint / gcc / most others: `src/x.ts:12:34: error: msg`
  /^\s*(?<path>[^\s:]+(?::[^\s:\d][^\s:]*)*):(?<line>\d+):(?<column>\d+)(?::\s*(?<rest>.*))?$/,
  // `src/x.ts:12: msg`
  /^\s*(?<path>[^\s:]+):(?<line>\d+)(?::\s*(?<rest>.*))?$/,
  // a node stack frame: `    at fn (/abs/x.ts:12:34)`
  /^\s*at\s+.*\((?<path>[^()]+):(?<line>\d+):(?<column>\d+)\)\s*$/,
]

/**
 * A line → its location, if it names one.
 *
 * Deliberately conservative. A false positive here is a Problems row that
 * opens the wrong file, which is worse than a diagnostic that only appears in
 * the raw output — so a "path" with no dot in its last segment, or a line
 * number of zero, is not treated as a location.
 */
export function parseLocation(line: string, projectRootHint?: string): OutputLocation | null {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(line)
    const groups = match?.groups
    if (!groups?.path || !groups.line) continue

    const lineNumber = Number(groups.line)
    if (!Number.isFinite(lineNumber) || lineNumber < 1) continue

    let path = groups.path
    // An absolute path from a compiler running on the server is more useful
    // made relative — that is the form every workspace route speaks.
    if (projectRootHint && path.startsWith(projectRootHint))
      path = path.slice(projectRootHint.length).replace(/^[\\/]/, "")
    path = path.split("\\").join("/")
    if (!path.includes(".")) continue

    const severityWord = SEVERITY.exec(groups.rest ?? line)?.[1]?.toLowerCase()
    const severity: OutputLocation["severity"] =
      severityWord === "error" ? "error" : severityWord?.startsWith("warn") ? "warning" : "info"

    return {
      relativePath: path,
      line: lineNumber,
      ...(groups.column ? { column: Number(groups.column) } : {}),
      severity,
    }
  }
  return null
}

/* ── Buffer ────────────────────────────────────────────────────────────────── */

/**
 * Append lines to a project's output.
 *
 * Splitting here rather than at every call site: every source produces text
 * with newlines in it, and a "record" that is really twelve lines cannot be
 * filtered, searched or turned into a problem.
 */
export function appendOutput(
  projectId: string,
  source: string,
  text: string,
  options: { projectRootHint?: string } = {}
): void {
  const lines = text.split("\n")
  const existing = buffers.get(projectId) ?? []
  const added: OutputRecord[] = []
  const at = Date.now()

  for (const line of lines) {
    if (!line.trim()) continue
    const location = parseLocation(line, options.projectRootHint)
    added.push({
      id: `${at}-${sequence++}`,
      projectId,
      source,
      message: line,
      at,
      ...(location ? { location } : {}),
    })
  }
  if (added.length === 0) return

  const next = [...existing, ...added]
  if (next.length > MAX_RECORDS) {
    const dropped = next.length - MAX_RECORDS
    next.splice(0, dropped)
    // No silent caps: something that vanished should say it vanished.
    console.warn(`[output] dropped ${dropped} old record(s) for project ${projectId}`)
    next[0] = {
      ...next[0],
      source: "daedalus",
      message: `… ${dropped} earlier line(s) dropped`,
    }
  }
  buffers.set(projectId, next)
  notify()
}

export function clearOutput(projectId: string): void {
  buffers.delete(projectId)
  notify()
}

export function outputFor(projectId: string): OutputRecord[] {
  return buffers.get(projectId) ?? EMPTY
}

/** Reactive read. Same `useSyncExternalStore` shape as the other tiny stores. */
export function useOutput(projectId: string): OutputRecord[] {
  return React.useSyncExternalStore(
    React.useCallback((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }, []),
    React.useCallback(() => outputFor(projectId), [projectId])
  )
}

/** Sources seen in a project's buffer, for the filter. */
export function sourcesIn(records: OutputRecord[]): string[] {
  return [...new Set(records.map((record) => record.source))].sort()
}

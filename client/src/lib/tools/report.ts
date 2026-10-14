/**
 * A subagent's JSON report, read for drawing.
 *
 * No per-shape knowledge: a survey of the reports agents actually return
 * (Claude Code workflow steps' `StructuredOutput`, 22 shapes) found the same
 * few roles under a handful of names — what an item is called, a short status
 * worth a badge, where it is in the code — and everything else is either a
 * short fact, a paragraph, or a list. So the reader sorts each object's fields
 * into those roles and the view draws roles, never keys. A shape nobody
 * surveyed still lands somewhere sensible, and the raw JSON is one toggle away.
 */

export type ReportValue = Record<string, unknown> | unknown[]

export type ReportTone = "bad" | "warn" | "good" | "neutral"
export type ReportBadge = { key: string; label: string; text: string; tone: ReportTone }
export type ReportField = { key: string; label: string; value: unknown }

export type ReportShape = {
  /** An item's name — only read for an object inside a list. */
  title?: string
  badges: ReportBadge[]
  /** `file:line`, or a page, when the object points somewhere. */
  location?: string
  /** Short scalars: ids, counts, shas — a key/value grid. */
  facts: ReportField[]
  /** Long strings, drawn as labelled paragraphs. */
  texts: ReportField[]
  /** Arrays and nested objects, in the order they came. */
  groups: ReportField[]
}

/* Ordered: the first one present names the item. */
const TITLE_KEYS = ["title", "question", "problem", "summary", "issue", "name", "key", "command", "cmd", "task_id"]
const BADGE_KEYS = new Set([
  "severity", "priority", "verdict", "outcome", "confidence", "effort", "layer", "status", "result", "plan", "state",
])
const BADGE_MAX = 24
const FACT_MAX = 60

const TONES: Record<string, ReportTone> = {}
for (const word of ["critical", "blocker", "high", "major", "error", "failed", "fail", "incorrect", "wrong", "refused", "permission_denied", "no"]) TONES[word] = "bad"
for (const word of ["medium", "moderate", "partial", "unverifiable", "unclear", "warning", "skipped"]) TONES[word] = "warn"
for (const word of ["pass", "passed", "ok", "confirmed", "correct", "answered", "done", "fixed", "yes"]) TONES[word] = "good"

export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase())
}

/** The report as JSON, when it is a JSON object or array — bare or fenced. */
export function parseReport(text: string): ReportValue | null {
  const trimmed = text.trim()
  const source = (/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed).trim()
  if (!source.startsWith("{") && !source.startsWith("[")) return null
  try {
    const value: unknown = JSON.parse(source)
    return value !== null && typeof value === "object" ? (value as ReportValue) : null
  } catch {
    return null
  }
}

/** Every object in this array is a row of short scalars — draw it as a table. */
export function isTable(items: unknown[]): items is Record<string, unknown>[] {
  if (items.length === 0) return false
  const keys = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    for (const [key, value] of Object.entries(item)) {
      keys.add(key)
      if (value !== null && typeof value === "object") return false
      if (typeof value === "string" && value.length > 200) return false
    }
  }
  return keys.size <= 6
}

export function reportShape(value: Record<string, unknown>, item = false): ReportShape {
  const shape: ReportShape = { badges: [], facts: [], texts: [], groups: [] }
  const titleKey = item ? TITLE_KEYS.find((key) => typeof value[key] === "string" && value[key]) : undefined
  if (titleKey) shape.title = value[titleKey] as string

  const file = typeof value.file === "string" ? value.file : typeof value.path === "string" ? value.path : undefined
  const line = typeof value.line === "number" || typeof value.line === "string" ? value.line : undefined
  if (file) shape.location = line === undefined ? file : `${file}:${line}`
  else if (typeof value.page === "string") shape.location = value.page
  const placed = new Set(shape.location ? (file ? ["file", "path", "line"] : ["page"]) : [])

  for (const [key, raw] of Object.entries(value)) {
    if (key === titleKey || placed.has(key) || raw === undefined) continue
    const label = humanizeKey(key)
    if (typeof raw === "boolean") {
      shape.badges.push({ key, label, text: `${label}: ${raw ? "yes" : "no"}`, tone: raw ? "good" : "bad" })
    } else if (typeof raw === "string" && BADGE_KEYS.has(key) && raw.length <= BADGE_MAX) {
      shape.badges.push({ key, label, text: raw, tone: TONES[raw.toLowerCase()] ?? "neutral" })
    } else if (raw === null || typeof raw === "number" || (typeof raw === "string" && raw.length <= FACT_MAX && !raw.includes("\n"))) {
      shape.facts.push({ key, label, value: raw })
    } else if (typeof raw === "string") {
      shape.texts.push({ key, label, value: raw })
    } else {
      shape.groups.push({ key, label, value: raw })
    }
  }
  return shape
}

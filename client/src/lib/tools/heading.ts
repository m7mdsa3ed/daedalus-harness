/* ── Targets and headings ── the strings a step row prints about a call. */
import type * as acp from "@agentclientprotocol/sdk"
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { extractMcpCall } from "./mcp"
import { NAME_RE, toolDisplayName, toolIdentity, toolKindOf } from "./naming"
import { displayUrl, webInput } from "./web"

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Elide from the middle: the basename and the top of the tree both survive. */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path
  const parts = path.split("/")
  if (parts.length <= 2) return `…${path.slice(-(max - 1))}`
  const last = parts[parts.length - 1]
  let out = last
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}/${out}`
    if (next.length + 2 > max) break
    out = next
  }
  return `…/${out}`
}

// ─── Input ───────────────────────────────────────────────────────────────────

/* A heredoc script is one "command" but twenty lines long. Collapsing all of
   its whitespace turns the row into a run-on smear, so a multi-line value shows
   its first line and says there is more. */
function firstLine(value: string): string {
  const lines = value.split("\n")
  const index = lines.findIndex((line) => line.trim().length > 0)
  if (index === -1) return ""
  const head = lines[index].trim().replace(/\s+/g, " ")
  const more = lines.slice(index + 1).some((line) => line.trim().length > 0)
  return more ? `${head} …` : head
}

/** Keys that carry "the thing acted on", in the order worth showing. */
const TARGET_KEYS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
]

/**
 * The single string for a step row's target column: the thing acted on, with
 * no tool name in front of it. The kind icon already says what happened, so
 * repeating "bash" before the command only costs horizontal space.
 */
export function toolTarget(item: Pick<ToolItem, "title" | "rawInput" | "meta" | "toolKind">): string {
  /* A web search is about its query and a fetch about its page, whichever
     server answered — these come before the MCP rule below, which would
     otherwise print `web-search · web search` for every one of them. */
  const web = webInput(item)
  if (web?.query) return `“${firstLine(web.query)}”`
  if (web?.url) return displayUrl(web.url)
  // An MCP call names its server first whichever runtime sent it, and its
  // arguments are the server's business — `{"server":"crm","tool":"search"}`
  // is not a target, it is the address of one.
  const mcp = extractMcpCall(item)
  if (mcp) return mcp.tool ? `${mcp.server} · ${mcp.tool}` : mcp.server
  const input = asRecord(item.rawInput)
  if (input) {
    /* A search is about its pattern, not about the directory it ran in:
       `pattern` sits after `path` in the general order (a read IS about its
       path), so a search reorders the two rather than the table doing it for
       everyone. */
    const keys =
      toolKindOf(item) === "search"
        ? ["pattern", "query", ...TARGET_KEYS]
        : TARGET_KEYS
    for (const key of keys) {
      const value = str(input[key])
      if (!value) continue
      if (key.toLowerCase().includes("path")) return shortPath(value, 72)
      return firstLine(value)
    }
  }
  /* The title beats the tool's own name whenever it is prose — "Update TODOs:
     rewire the reducer" says more than "todowrite", and every adapter writes
     one. The name is the answer only when the title IS the name, which is what
     NAME_RE is testing. */
  const name = toolIdentity(item)
  if (!name || !NAME_RE.test(item.title.trim())) {
    return item.title.trim() ? firstLine(item.title) : (name ? toolDisplayName(name) : item.title)
  }
  return toolDisplayName(name)
}

/**
 * The sentence the agent wrote about the call, when it sent one apart from the
 * thing it invoked.
 *
 * Claude Code's `Bash` carries a `description` in its input and repeats it on
 * `_meta.claudeCode.title`, while ACP's `title` and the input's `command` are
 * both the raw shell line: "Show recent git history and remote" is what the
 * agent meant to do, `git log --oneline -20 && echo "---BRANCH---" && …` is
 * what it typed. The sentence is the better row title — a 200-character
 * one-liner truncates to `git log --oneline -20 && echo "---BRA…`, which says
 * nothing the `run` label had not already said.
 *
 * With no explicit description, ACP's own prose `title` ("Update TODOs: rewire
 * the reducer") is the same thing the description field provides — it says what
 * the agent meant, where an identifier or a bare command does not. Only a
 * prose title counts: a title that `NAME_RE` accepts is a label ("Bash",
 * "todowrite"), which is the tool's name, not a description of the call.
 */
export function toolDescription(item: {
  meta?: unknown
  rawInput?: unknown
  title?: string | null
}): string | null {
  const meta = str(asRecord(asRecord(item.meta)?.claudeCode)?.title)
  const inputDescription = str(asRecord(item.rawInput)?.description)
  const explicit = meta ?? inputDescription
  if (explicit) return explicit
  const title = item.title?.trim()
  return title && !NAME_RE.test(title) ? title : null
}

/**
 * What a step row prints: the description as the title when there is one, with
 * the thing actually invoked underneath it. `detail` is absent when the two
 * would say the same thing — a `Task` names itself with its description and
 * nothing else, so repeating it as a second line is just a taller row.
 *
 * `file`/`filePath` are the row the call acted on, when it acted on a file: the
 * path is drawn as a badge (basename) rather than as a truncated mono line, so
 * "Read /path/to/file" reads as "Read" + a file chip instead of an elided path.
 */
export interface ToolHeading {
  title: string
  /** The command/path/pattern, when the title is prose *about* it. */
  detail?: string
  /** The title is a sentence, not an identifier — don't set it in mono. */
  prose: boolean
  /** The file this call acted on, as a basename — rendered as a badge chip. */
  file?: string
  /** The full path behind the badge, for its tooltip. */
  filePath?: string
}

/* The keys that mean "a file", as opposed to a command, pattern or url. When
   the target came from one of these, the row acts on a file — and the path is
   better drawn as a badge (its basename) than as a mono line that elides the
   middle and keeps a directory we were only ever going to truncate. */
const FILE_KEYS = new Set(["file_path", "filePath", "path", "notebook_path"])

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Drop a file reference from the tail of a sentence, so "Read src/index.ts"
    (the description) and a `src/index.ts` badge never say the path twice. The
    full path is tried first, then the basename, then a dangling separator left
    by stripping a basename that was only the last segment of the path. */
function stripTrailingFileRef(text: string, path: string, name: string): string {
  let out = text
  for (const ref of [path, name]) {
    out = out.replace(new RegExp(`(?:\\s*[-–:]?\\s*${escapeRegExp(ref)})$`, "i"), "")
  }
  return out.replace(/[\s/:]+$/, "").trim()
}

/** The path this call acted on, when it acted on a file. Returns the full text
    (to strip out of a heading that repeats it) and the basename (the badge).
    Null when the target is a command/pattern/url/name — so a grep over a path
    doesn't badge the pattern it searched for as if that pattern were a file.
    Falls back to the first location only when no input key picked the target,
    which is where a write's path lives when the arguments carry the body only. */
function fileTargetOf(
  item: {
    rawInput?: unknown
    meta?: Record<string, unknown>
    toolKind?: ToolItem["toolKind"]
    locations?: acp.ToolCallLocation[]
    title?: string | null
  }
): { path: string; name: string } | null {
  const input = asRecord(item.rawInput)
  const normalized = { ...item, title: item.title ?? "" }
  if (input && !extractMcpCall(normalized)) {
    /* Same key order `toolTarget` uses — the key that produced the target is
       the one that decides whether the target IS a file. */
    const keys =
      toolKindOf(normalized) === "search"
        ? ["pattern", "query", ...TARGET_KEYS]
        : TARGET_KEYS
    for (const key of keys) {
      const value = str(input[key])
      if (!value) continue
      if (!FILE_KEYS.has(key)) return null
      const path = value.replace(/\\/g, "/")
      return { path, name: path.split("/").pop() ?? path }
    }
  }
  const location = item.locations?.[0]?.path
  if (location) {
    const path = location.replace(/\\/g, "/")
    return { path, name: path.split("/").pop() ?? path }
  }
  return null
}

/** The verb a kind's label becomes when there is no description to lead with —
    "Read package.json", "Run git log…" — so a row says what happened rather
    than echoing the bare identifier the agent typed. The kind `other` is left
    out: its label ("tool") is not a verb. */
const KIND_VERB: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  fetch: "Fetch",
}

export function toolHeading(
  item: {
    title?: string | null
    rawInput?: unknown
    meta?: Record<string, unknown>
    toolKind?: ToolItem["toolKind"]
    locations?: acp.ToolCallLocation[]
  }
): ToolHeading {
  const target = toolTarget({ ...item, title: item.title ?? "" })
  /* The web has its own two verbs, and they beat whatever the agent titled
     the call: Claude Code's built-in `WebSearch` titles itself `"query"` in
     quotes and the harness's server `mcp__web-search__web_search`, and one
     row should read the same as the other. A search is not a "Fetch" (the
     kind the name table files it under, for the globe icon) and a page is
     not a file, so neither goes through the badge logic below: the query or
     the address IS the row. */
  const web = webInput({ ...item, title: item.title ?? "" })
  if (web?.query) return { title: `Search the web for ${target}`, prose: true }
  if (web?.url) return { title: `Fetch ${target}`, prose: false }
  const description = toolDescription(item)
  /* The file badge: if the target IS a file, that is the chip, and the
     description's own mention of the path is cut so the sentence doesn't repeat
     the badge ("Read src/index.ts" becomes "Read" + a `src/index.ts` chip). */
  const file = fileTargetOf(item)
  const fileInTitle =
    file && description && description.toLowerCase().includes(file.name.toLowerCase())

  if (!description) {
    /* The agent sent no prose, so the title is the thing it acted on. Prefix it
       with the kind's verb rather than printing the command alone — a bash row
       that said "git log --oneline" said nothing the kind icon hadn't. The verb
       is skipped when the target already reads as one ("Read package.json" as
       the title), which is the prose-title fallback's own wording. */
    const verb = KIND_VERB[toolKindOf({ ...item, title: item.title ?? "" })]
    const hasVerb = verb && target.trim() && !new RegExp(`^${verb}\\s`, "i").test(target)
    /* The file IS the title: drop the path from the row and let the badge carry
       it, so "Read /path/to/file" reads as "Read" + a `file` chip instead of an
       elided mono path. */
    if (file) return { title: hasVerb ? verb : "", file: file.name, filePath: file.path, prose: false }
    return hasVerb ? { title: `${verb} ${target}`, prose: false } : { title: target, prose: false }
  }
  const title = firstLine(description)
  const base: ToolHeading = { title, detail: title === target ? undefined : target, prose: true }
  /* The description leads, and the file is drawn as the chip it mentions — the
     path is dropped from both the title and the mono detail so the row never
     says the path twice. A `Read src/index.ts` prose title keeps only "Read". */
  if (file && fileInTitle) {
    const cleaned = stripTrailingFileRef(title, file.path, file.name)
    return {
      title: cleaned || "Read",
      detail: undefined,
      file: file.name,
      filePath: file.path,
      prose: true,
    }
  }
  return base
}

/** The most useful single string in the input, if any — the "command". */
export function toolPrimaryText(item: Pick<ToolItem, "rawInput">): string | null {
  const input = asRecord(item.rawInput)
  if (!input) return typeof item.rawInput === "string" ? item.rawInput : null
  for (const key of ["command", "prompt", "query", "pattern", "url", "plan", "new_source", "content"]) {
    const value = str(input[key])
    if (value) return value
  }
  return null
}

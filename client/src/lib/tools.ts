/* ── Reading a tool call ──
   ACP describes a tool call generically: a title, an optional `kind`, and two
   opaque blobs (`rawInput`, `rawOutput`) whose shape is the runtime's business,
   not the protocol's. Rendering a shell run as a shell run — command on a `$`
   line, stream underneath — means looking inside those blobs.

   Everything here is best-effort inference, and it is all in one file so that
   "the client knows too much about agents" stays quarantined rather than
   spreading through the transcript components. The rule: read `kind` first
   (that IS protocol), fall back to the tool's name only when the agent did not
   send one, and return null rather than guessing when neither answers.

   Ported from /var/www/mawared-off/social-live-agent/ai-agent-web. */
import type { ToolItem } from "./store"

export type ToolKind = NonNullable<ToolItem["toolKind"]>

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

// ─── Names ───────────────────────────────────────────────────────────────────

/* ACP has no tool-name field — `title` is human-readable prose ("Read
   package.json") for most agents, but several send the bare identifier
   ("Bash", "mcp__crm__search"). Treat the title as a name only when it looks
   like one, so a prose title never gets matched against the table below. */
const NAME_RE = /^(mcp__)?[A-Za-z_][A-Za-z0-9_]*$/

export function toolNameOf(item: Pick<ToolItem, "title">): string | null {
  const title = item.title.trim()
  return NAME_RE.test(title) ? title.toLowerCase() : null
}

/** Common tool names across runtimes → a display kind, when ACP didn't send one. */
const NAME_KINDS: Record<string, ToolKind> = {
  bash: "execute",
  shell: "execute",
  run: "execute",
  execute: "execute",
  terminal: "execute",
  read: "read",
  readfile: "read",
  read_file: "read",
  cat: "read",
  ls: "read",
  list: "read",
  write: "edit",
  writefile: "edit",
  write_file: "edit",
  edit: "edit",
  editfile: "edit",
  multiedit: "edit",
  str_replace: "edit",
  apply_patch: "edit",
  notebookedit: "edit",
  glob: "search",
  grep: "search",
  search: "search",
  find: "search",
  webfetch: "fetch",
  fetch: "fetch",
  websearch: "fetch",
  web_search: "fetch",
  task: "other",
  agent: "other",
  todowrite: "other",
  todoread: "other",
}

/** The kind to render a call as: the protocol's answer, else the name's. */
export function toolKindOf(item: Pick<ToolItem, "title" | "toolKind">): ToolKind {
  if (item.toolKind) return item.toolKind
  const name = toolNameOf(item)
  if (!name) return "other"
  return NAME_KINDS[name.replace(/^mcp__/, "")] ?? "other"
}

/**
 * Split the `mcp__<server>__<tool>` naming convention every harness uses for
 * MCP-provided tools. Null for ordinary tool names.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  const words = (value: string) => value.replace(/_/g, " ").trim()
  if (sep <= 0) return { server: words(rest), tool: "" }
  return { server: words(rest.slice(0, sep)), tool: words(rest.slice(sep + 2)) }
}

/**
 * A tool name as a human reads it: an MCP tool names its server first, so a
 * row says which integration acted, not just `mcp__crm_kb__search_docs`.
 */
export function toolDisplayName(name: string): string {
  const mcp = parseMcpToolName(name)
  if (!mcp) return name
  return mcp.tool ? `${mcp.server} · ${mcp.tool}` : mcp.server
}

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
export function toolTarget(item: Pick<ToolItem, "title" | "rawInput">): string {
  const input = asRecord(item.rawInput)
  if (input) {
    for (const key of TARGET_KEYS) {
      const value = str(input[key])
      if (!value) continue
      if (key.toLowerCase().includes("path")) return shortPath(value, 72)
      return firstLine(value)
    }
  }
  const name = toolNameOf(item)
  return name ? toolDisplayName(name) : item.title
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

// ─── Heredocs ────────────────────────────────────────────────────────────────

/**
 * A shell command that carries a heredoc is two languages in one string: the
 * shell around it, and whatever the body is written in. Highlighting the whole
 * thing as bash paints an embedded Python script in shell colours, which is
 * worse than leaving it grey — so the body is split out and typed separately.
 */
export interface CommandSegment {
  kind: "shell" | "heredoc"
  text: string
  /** The heredoc's delimiter word, for the block's label. */
  label?: string
  /** Inferred language of a heredoc body; undefined = do not colour. */
  language?: string
}

/* `<<`, an optional `-` (tab-stripping form), optional quoting, then the
   delimiter word. `<<<` (here-string) does not match: after `<<` the next
   character is `<`, which is neither a quote nor a word character. */
const HEREDOC_RE = /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/g

/** Delimiter words that announce their own language — the common convention. */
const DELIM_LANG: Record<string, string> = {
  py: "python", python: "python", py3: "python",
  js: "javascript", node: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "tsx",
  rb: "ruby", ruby: "ruby",
  go: "go", rs: "rust", rust: "rust", php: "php",
  sql: "sql", json: "json", yaml: "yaml", yml: "yaml",
  html: "html", css: "css", scss: "scss", xml: "xml",
  md: "markdown", markdown: "markdown",
  toml: "toml", ini: "toml", conf: "toml",
  sh: "bash", bash: "bash", zsh: "bash",
  dockerfile: "docker", docker: "docker",
  c: "c", cpp: "cpp", java: "java", cs: "csharp",
}

/** Interpreters that say what the body they are being fed is written in. */
const INTERPRETER_LANG: [RegExp, string][] = [
  [/\bpython[0-9.]*\b/, "python"],
  [/\bnode\b/, "javascript"],
  [/\b(ts-node|tsx)\b/, "typescript"],
  [/\bruby\b/, "ruby"],
  [/\b(psql|sqlite3|mysql|mariadb)\b/, "sql"],
  [/\bjq\b/, "json"],
  [/\bphp\b/, "php"],
  [/\b(bash|sh|zsh)\b/, "bash"],
]

/** The language of a heredoc body: what the delimiter says, else what the
    interpreter implies, else the extension of the file it is redirected into. */
function heredocLanguage(delimiter: string, opener: string): string | undefined {
  const byDelimiter = DELIM_LANG[delimiter.toLowerCase()]
  if (byDelimiter) return byDelimiter

  const head = opener.slice(0, opener.search(HEREDOC_RE) + 1)
  for (const [pattern, language] of INTERPRETER_LANG) {
    if (pattern.test(head)) return language
  }

  const redirect = /(?:>>?|\btee\b)\s*(\S+\.([A-Za-z0-9]+))/.exec(opener)
  return redirect ? EXT_LANG[redirect[2].toLowerCase()] : undefined
}

/**
 * Split a command into shell and heredoc-body segments.
 *
 * A heredoc is only recognised when its terminator is actually found: `echo "a
 * << b"` would otherwise swallow the whole rest of the script. Input arrives
 * whole (it is output that streams), so requiring the terminator costs nothing
 * real and removes the entire class of false positives.
 */
export function splitCommand(command: string): CommandSegment[] {
  const lines = command.split("\n")
  const segments: CommandSegment[] = []
  let shell: string[] = []

  const flushShell = () => {
    if (shell.length) segments.push({ kind: "shell", text: shell.join("\n") })
    shell = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    shell.push(line)
    const openers = [...line.matchAll(HEREDOC_RE)].map((match) => match[2] ?? match[3])
    if (openers.length === 0) continue

    // Bodies follow in the order their openers appeared on the line.
    for (const delimiter of openers) {
      const end = lines.findIndex(
        (candidate, index) => index > i && candidate.trim() === delimiter
      )
      if (end === -1) continue
      flushShell()
      segments.push({
        kind: "heredoc",
        label: delimiter,
        language: heredocLanguage(delimiter, line),
        text: lines.slice(i + 1, end).join("\n"),
      })
      i = end // the terminator is the block's own bottom edge; drop the line.
    }
  }

  flushShell()
  return segments
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", css: "css", scss: "scss",
  html: "html", xml: "xml", md: "markdown", mdx: "markdown", env: "bash", dockerfile: "docker",
}

/**
 * Fence language for a tool's payload: the shell for a bash-ish call, else the
 * extension of the path it acted on. Undefined = no highlight, which is the
 * honest answer for prose prompts and search patterns.
 */
export function toolLanguage(item: Pick<ToolItem, "rawInput" | "locations">): string | undefined {
  const input = asRecord(item.rawInput)
  if (input && typeof input.command === "string") return "bash"
  const path =
    ["file_path", "filePath", "path", "notebook_path"]
      .map((key) => str(input?.[key]))
      .find(Boolean) ?? item.locations[0]?.path
  if (!path) return undefined
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

/**
 * Some runtimes carry an edit's before/after in the tool *input* instead of
 * emitting a `diff` content block — snake_case (Claude Code, Codex) or
 * camelCase (OpenCode). Surface it so those edits render as a diff rather than
 * as raw JSON.
 */
export interface EditInputDiff {
  oldText: string
  newText: string
  path?: string
}

export function extractEditInput(item: Pick<ToolItem, "rawInput" | "locations">): EditInputDiff | null {
  const input = asRecord(item.rawInput)
  if (!input) return null
  const oldText = str(input.old_string) ?? str(input.oldString) ?? str(input.old_str)
  const newText = str(input.new_string) ?? str(input.newString) ?? str(input.new_str)
  if (oldText === null || newText === null) return null
  return {
    oldText,
    newText,
    path: str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? item.locations[0]?.path,
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** Anything a runtime calls "output", as text. Flattens ACP content arrays,
    falls back to pretty JSON, and reports whether it had to cut. */
export function stringifyOutput(
  value: unknown,
  max = 20_000
): { text: string; truncated: boolean } {
  let text: string
  if (typeof value === "string") text = value
  else if (value === undefined || value === null) text = ""
  else if (Array.isArray(value)) {
    const blocks = value
      .map((entry) => {
        const record = asRecord(entry)
        if (!record) return typeof entry === "string" ? entry : null
        const inner = asRecord(record.content)
        return str(inner?.text) ?? str(record.text) ?? null
      })
      .filter((entry): entry is string => entry !== null)
    text = blocks.length === value.length ? blocks.join("\n") : safeJson(value)
  } else {
    const record = asRecord(value)
    // The common single-field wrappers: {output}, {stdout}, {text}, {result}.
    const unwrapped = record
      ? (str(record.output) ?? str(record.stdout) ?? str(record.text) ?? str(record.result))
      : null
    text = unwrapped ?? safeJson(value)
  }
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

/** The text a tool produced: `rawOutput` when the agent sent one, else the
    text it streamed into `content`. */
export function toolOutputText(item: ToolItem, max = 20_000): { text: string; truncated: boolean } {
  if (item.rawOutput !== undefined && item.rawOutput !== null) {
    return stringifyOutput(item.rawOutput, max)
  }
  const text = item.content
    .map((block) =>
      block.type === "content" && block.content.type === "text" ? block.content.text : ""
    )
    .filter(Boolean)
    .join("\n")
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }
}

export const toolFailed = (item: ToolItem): boolean => item.status === "failed"

// ─── Background tasks ────────────────────────────────────────────────────────

/**
 * Work a tool call launched that outlives its turn: the agent keeps running it
 * after the prompt returns and appends progress to a journal on the server's
 * disk. Claude Code's Workflow tool reports the launch through
 * `_meta.claudeCode.toolResponse` — a vendor shape, which is why reading it
 * lives here. The transcript dir is the handle everything else keys on: the
 * server tails `<dir>/journal.jsonl` (`/api/tasks/watch`) and the panel reads
 * the events out of `lib/task-events`.
 */
export interface BackgroundTask {
  transcriptDir: string
  runId?: string
  workflowName?: string
  summary?: string
}

export function extractBackgroundTask(item: Pick<ToolItem, "meta">): BackgroundTask | null {
  const claude = asRecord(asRecord(item.meta)?.claudeCode)
  const response = asRecord(claude?.toolResponse)
  const transcriptDir = str(response?.transcriptDir)
  if (!transcriptDir) return null
  return {
    transcriptDir,
    runId: str(response?.runId) ?? undefined,
    workflowName: str(response?.workflowName) ?? undefined,
    summary: str(response?.summary) ?? undefined,
  }
}

/** One subagent's life in a task journal: `started` opens it, `result` (or
    `error`) closes it. Order of first appearance is the display order. */
export interface TaskAgentRow {
  agentId: string
  done: boolean
  failed: boolean
  result?: unknown
}

export function taskAgentRows(events: { type?: string; agentId?: string; [k: string]: unknown }[]): TaskAgentRow[] {
  const rows = new Map<string, TaskAgentRow>()
  for (const event of events) {
    if (typeof event.agentId !== "string") continue
    const row = rows.get(event.agentId) ?? {
      agentId: event.agentId,
      done: false,
      failed: false,
    }
    if (event.type === "result") {
      row.done = true
      row.result = event.result
    } else if (event.type === "error") {
      row.done = true
      row.failed = true
    }
    rows.set(event.agentId, row)
  }
  return [...rows.values()]
}

/**
 * The end of a background task, as the harness announces it.
 *
 * When the task finishes, the runtime injects a `<task-notification>` block
 * into the conversation as a synthetic *user* turn — the model is meant to
 * read it and carry on. It is not prose and nobody typed it, so left alone it
 * renders as a user bubble full of XML. Parsing it here (vendor shape, same
 * quarantine as everything else in this file) lets the transcript show what
 * actually happened: how many agents ran, which failed, and why.
 *
 * Tolerates an unterminated block so a notification renders while it is still
 * streaming, the same bargain `PROPOSED_PLAN_RE` makes in thread-items.
 */
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification|$)/

export interface TaskFailure {
  /** The stage that failed, e.g. `audit:server`. */
  label: string
  message: string
}

export interface TaskNotification {
  taskId?: string
  status?: string
  summary?: string
  /** The task's return value, when it returned one worth showing. */
  result?: string
  failures: TaskFailure[]
  /** The per-agent journal named in the diagnostics — the same directory the
      live panel tails, so the two halves describe one task. */
  transcriptDir?: string
  agentCount?: number
  agentsDone?: number
  agentsError?: number
  subagentTokens?: number
  toolUses?: number
  durationMs?: number
}

const tagText = (body: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return match ? match[1].trim() : null
}

const tagNumber = (body: string, name: string): number | undefined => {
  const text = tagText(body, name)
  const value = text === null ? NaN : Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** `[stage] failed: why` — one per line, with wrapped messages continuing. */
const FAILURE_RE = /^\[([^\]]+)\]\s*(?:failed:)?\s*([\s\S]*)$/

export function parseTaskNotification(text: string): TaskNotification | null {
  const match = TASK_NOTIFICATION_RE.exec(text.trim())
  if (!match) return null
  const body = match[1]

  const failures: TaskFailure[] = []
  for (const line of (tagText(body, "failures") ?? "").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const failure = FAILURE_RE.exec(trimmed)
    if (failure) failures.push({ label: failure[1], message: failure[2].trim() })
    // A message that wrapped onto its own line belongs to the failure above it.
    else if (failures.length > 0) failures[failures.length - 1].message += ` ${trimmed}`
  }

  const usage = tagText(body, "usage") ?? ""
  const journal = /(\/\S+)\/journal\.jsonl/.exec(tagText(body, "diagnostics") ?? "")
  // `null` is the runtime's own word for "the task returned nothing" — showing
  // it would be quoting a placeholder back at the reader.
  const result = tagText(body, "result")
  return {
    taskId: tagText(body, "task-id") ?? undefined,
    status: tagText(body, "status") ?? undefined,
    summary: tagText(body, "summary") ?? undefined,
    result: result && result !== "null" ? result : undefined,
    failures,
    transcriptDir: journal?.[1],
    agentCount: tagNumber(usage, "agent_count"),
    agentsDone: tagNumber(usage, "agents_done"),
    agentsError: tagNumber(usage, "agents_error"),
    subagentTokens: tagNumber(usage, "subagent_tokens"),
    toolUses: tagNumber(usage, "tool_uses"),
    durationMs: tagNumber(usage, "duration_ms"),
  }
}

/** Finding titles out of structured agent results, when they carry any — the
    `{findings: [{title}]}` shape workflow finder/verifier stages return. */
export function taskFindings(rows: TaskAgentRow[]): string[] {
  return rows.flatMap((row) => {
    const findings = asRecord(row.result)?.findings
    if (!Array.isArray(findings)) return []
    return findings
      .map((finding) => str(asRecord(finding)?.title))
      .filter((title): title is string => title !== null)
  })
}

// ─── Summary ─────────────────────────────────────────────────────────────────

/** Multiset line difference — honest churn counts without a full LCS. */
export function diffStats(
  oldText: string | null | undefined,
  newText: string
): { added: number; removed: number } {
  const oldLines = oldText ? oldText.split("\n") : []
  const counts = new Map<string, number>()
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of newText.split("\n")) {
    const seen = counts.get(line) ?? 0
    if (seen > 0) counts.set(line, seen - 1)
    else added++
  }
  let removed = 0
  for (const count of counts.values()) removed += count
  return { added, removed }
}

/**
 * The one-line story of a tool call — churn for edits, match counts for
 * searches, an actual line of output otherwise — so the closed row already
 * says what happened and the expansion is for reading, not for finding out.
 *
 * While the call runs, output is still arriving, so the *last* line is whatever
 * it just produced. Once it settles the last line is usually a trailing blank
 * or a prompt echo, and the *first* line is the one worth freezing on the row.
 */
export function toolSummary(item: ToolItem, active: boolean): string | null {
  if (item.status === "failed") return "error"

  const diffs = item.content.filter(
    (block): block is Extract<typeof block, { type: "diff" }> => block.type === "diff"
  )
  const churn = diffs.length
    ? diffs.reduce(
        (total, block) => {
          const stats = diffStats(block.oldText, block.newText)
          return { added: total.added + stats.added, removed: total.removed + stats.removed }
        },
        { added: 0, removed: 0 }
      )
    : (() => {
        const edit = extractEditInput(item)
        return edit ? diffStats(edit.oldText, edit.newText) : null
      })()
  if (churn) return `+${churn.added} −${churn.removed}`

  const { text } = toolOutputText(item, 100_000)
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null

  if (toolKindOf(item) === "search") {
    return `${lines.length} ${lines.length === 1 ? "match" : "matches"}`
  }

  const line = (active ? lines[lines.length - 1] : lines[0]).trim()
  return line.length > 44 ? `${line.slice(0, 44)}…` : line
}

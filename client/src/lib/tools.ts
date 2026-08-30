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
import type * as acp from "@agentclientprotocol/sdk"
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

/** The kind to render a call as: the protocol's answer, else the name's.

    The name is read through `toolIdentity` (defined below, next to the rest of
    the vendor-shape readers) rather than off the title alone: Claude Code's
    titles are prose, so a call whose kind the adapter omitted used to fall all
    the way through to "other" even though its name was sitting in `_meta`. */
export function toolKindOf(item: Pick<ToolItem, "title" | "toolKind" | "meta">): ToolKind {
  if (item.toolKind) return item.toolKind
  const name = toolIdentity(item)
  if (!name) return "other"
  return NAME_KINDS[name.replace(/^mcp__/, "")] ?? "other"
}

/**
 * Split the `mcp__<server>__<tool>` naming convention every harness uses for
 * MCP-provided tools. Null for ordinary tool names.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const words = (value: string) => value.replace(/_/g, " ").trim()
  // Codex's form. Its separator is a dot and a server name may not contain
  // one, so the first two segments are the whole answer and the rest of the
  // tool name (which may itself contain dots) is kept intact.
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) return { server: words(dotted[1]), tool: words(dotted[2]) }
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
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
export function toolTarget(item: Pick<ToolItem, "title" | "rawInput" | "meta" | "toolKind">): string {
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
    /* The single-field wrappers a runtime puts its output inside:
       `{output}`, `{stdout, stderr}`, `{text}`, `{result}`, and Codex's
       `{formatted_output, exit_code}` — printing the JSON around any of them
       shows the reader the envelope instead of the letter.

       `text`, not `str`: an empty string is a real answer here — a command
       that printed nothing — and treating it as absent fell through to
       stringifying the wrapper, so a silent success rendered as
       `{"formatted_output": "", "exit_code": 0}`. */
    const text_ = (key: string): string | null =>
      record && typeof record[key] === "string" ? (record[key] as string) : null
    const streams = record
      ? ["stdout", "stderr"]
          .map(text_)
          .filter((part): part is string => part !== null && part.length > 0)
      : []
    const unwrapped =
      text_("output") ??
      text_("formatted_output") ??
      (streams.length > 0 ? streams.join("\n") : (text_("stdout") ?? text_("stderr"))) ??
      text_("text") ??
      text_("result")
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
  // A terminal's stream beats both, and beats them even mid-run: it is the
  // only source that exists while the command is still printing, and at the
  // end it is the same bytes `rawOutput.formatted_output` repeats.
  if (item.terminal && item.terminal.data.length > 0) {
    const data = item.terminal.data
    return data.length > max
      ? { text: data.slice(0, max), truncated: true }
      : { text: data, truncated: false }
  }
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
        // Every hunk, not just the first: a MultiEdit's churn is the sum of
        // its edits, and a Write's is the whole file it created.
        const edits = extractEdits(item)
        if (edits.length === 0) return null
        return edits.reduce(
          (total, edit) => {
            const stats = diffStats(edit.oldText, edit.newText)
            return { added: total.added + stats.added, removed: total.removed + stats.removed }
          },
          { added: 0, removed: 0 }
        )
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

// ─── Vendor identity ─────────────────────────────────────────────────────────

/* Everything below reads *which tool this was*, not just what ACP called it.
   Three runtimes name the same act three ways — Claude Code's `TodoWrite`,
   OpenCode's `todowrite` and Codex's `update_plan` are one checklist; `Edit`,
   `edit` and `apply_patch` are one write — and ACP's `kind` deliberately does
   not distinguish them. `kind` still decides the *layout family* (that is the
   part that is protocol); the name decides which of the specialised views
   inside a family applies, and a name nobody recognises falls back to the
   family. Same quarantine rule as the rest of this file: the transcript asks
   questions here, it never matches on a vendor string itself. */

/**
 * The tool's own identifier, lowercased.
 *
 * `title` is prose for most Claude Code calls ("Read package.json"), so the
 * name has to come from the meta channel the adapter puts it on; Codex names
 * its MCP calls `mcp.<server>.<tool>` in the title and OpenCode sends the bare
 * identifier. Null when nothing in the payload looks like a name.
 */
export function toolIdentity(item: Pick<ToolItem, "title" | "meta">): string | null {
  const claude = str(asRecord(asRecord(item.meta)?.claudeCode)?.toolName)
  if (claude) return claude.toLowerCase()
  const title = item.title.trim()
  // Codex's MCP form: `mcp.<server>.<tool>`, which NAME_RE rejects (dots).
  if (/^mcp\.[^.\s]+\.\S+$/.test(title)) return title.toLowerCase()
  return NAME_RE.test(title) ? title.toLowerCase() : null
}

/** The identity with any MCP prefix stripped — `edit`, `todowrite`, `task`. */
const bareIdentity = (item: Pick<ToolItem, "title" | "meta">): string | null => {
  const name = toolIdentity(item)
  return name ? name.replace(/^mcp__/, "") : null
}

const isOneOf = (item: Pick<ToolItem, "title" | "meta">, names: string[]): boolean => {
  const name = bareIdentity(item)
  return name !== null && names.includes(name)
}

// ─── Terminal streams ────────────────────────────────────────────────────────

/**
 * A shell run that arrives as a terminal rather than as content.
 *
 * Codex announces every command as `content: [{type:"terminal"}]` and then
 * streams the bytes through `_meta.terminal_output_delta` on later updates —
 * unconditionally, whether or not the client claimed the terminal capability.
 * Nothing in ACP's own fields carries that output, so a client that only reads
 * `content`/`rawOutput` shows an empty box for the entire run and a
 * `{formatted_output, exit_code}` blob at the end.
 *
 * The deltas are *deltas*: `_meta` is merged key-wise per update, so the last
 * chunk would be the only chunk that survived. They are accumulated into the
 * item as they arrive instead — which is also what makes replay work, since a
 * replayed thread runs the same reducer over the same journaled updates.
 */
export interface TerminalState {
  /** Everything the command has printed so far. */
  data: string
  /** Set once the process exits; `null` means "exited, no code reported". */
  exitCode?: number | null
  /** Signal name, when the runtime reported one. */
  signal?: string | null
}

export function applyTerminalMeta(
  prev: TerminalState | undefined,
  meta: unknown
): TerminalState | undefined {
  const record = asRecord(meta)
  if (!record) return prev
  let next = prev

  const append = (chunk: string | null) => {
    if (chunk === null) return
    next = { ...(next ?? { data: "" }), data: (next?.data ?? "") + chunk }
  }

  // A snapshot replaces; a delta appends. Codex sends whichever mode the
  // client's capabilities selected, and the completion update may repeat the
  // whole aggregated output as a snapshot — replacing is what keeps that from
  // doubling the log.
  const snapshot = asRecord(record.terminal_output)
  if (snapshot) next = { ...(next ?? { data: "" }), data: str(snapshot.data) ?? "" }
  append(str(asRecord(record.terminal_output_delta)?.data))
  // MCP servers stream progress notifications the same way. It is log output
  // for the same call, so it lands in the same buffer rather than inventing a
  // second pane nobody would look at.
  const mcpDelta = str(asRecord(record.mcp_output_delta)?.data)
  if (mcpDelta !== null) append(next?.data ? `\n${mcpDelta}` : mcpDelta)

  const exit = asRecord(record.terminal_exit)
  if (exit) {
    next = {
      ...(next ?? { data: "" }),
      exitCode: typeof exit.exit_code === "number" ? exit.exit_code : null,
      signal: str(exit.signal),
    }
  }
  return next
}

/** True when the agent said "this call is a terminal" — the content block is a
    handle, not a payload, so rendering it as one prints `[terminal]`. */
export const hasTerminalContent = (item: Pick<ToolItem, "content">): boolean =>
  item.content.some((block) => block.type === "terminal")

// ─── Todo lists ──────────────────────────────────────────────────────────────

/**
 * The agent's checklist, however its runtime spells one.
 *
 * Claude Code's `TodoWrite` and OpenCode's `todowrite` both pass the whole list
 * as tool *input* and return nothing worth reading, and neither maps to ACP's
 * `plan` channel — so without this the most-repeated call in a long thread
 * renders as a JSON dump of the same array over and over. Codex is the
 * exception and needs nothing here: it sends a real ACP plan, which the
 * transcript already draws as a plan.
 *
 * Field names differ (`activeForm` vs `content`, an `id`/`priority` OpenCode
 * carries and Claude does not) and so does the status vocabulary, so both are
 * normalised onto ACP's own three statuses — the ones `PlanStep` already
 * knows how to colour.
 */
export interface TodoEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "high" | "medium" | "low"
}

const TODO_STATUS: Record<string, TodoEntry["status"]> = {
  pending: "pending",
  todo: "pending",
  not_started: "pending",
  queued: "pending",
  in_progress: "in_progress",
  active: "in_progress",
  running: "in_progress",
  started: "in_progress",
  completed: "completed",
  done: "completed",
  complete: "completed",
  // A cancelled item is finished, not pending — folding it into `completed`
  // keeps the counter honest without inventing a fourth colour.
  cancelled: "completed",
  canceled: "completed",
  skipped: "completed",
}

const TODO_PRIORITY = new Set(["high", "medium", "low"])

function readTodoList(value: unknown): TodoEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const todos: TodoEntry[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    // `activeForm` is the present-tense phrasing Claude Code sends alongside
    // the imperative one; it is the better label while the item is running.
    const status = TODO_STATUS[String(record.status ?? "").toLowerCase()] ?? "pending"
    const content =
      (status === "in_progress" ? str(record.activeForm) : null) ??
      str(record.content) ??
      str(record.text) ??
      str(record.title) ??
      str(record.task) ??
      str(record.activeForm)
    if (!content) continue
    const priority = String(record.priority ?? "").toLowerCase()
    todos.push({
      content,
      status,
      priority: TODO_PRIORITY.has(priority) ? (priority as TodoEntry["priority"]) : undefined,
    })
  }
  return todos.length > 0 ? todos : null
}

export function extractTodos(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "rawOutput">): TodoEntry[] | null {
  const input = asRecord(item.rawInput)
  // The list lives in the input; the output is an acknowledgement. Read the
  // output only as a fallback, for a runtime that echoes the list back and
  // sends no input at all.
  return (
    readTodoList(input?.todos) ??
    readTodoList(input?.todo_list) ??
    readTodoList(input?.items) ??
    readTodoList(asRecord(item.rawOutput)?.todos) ??
    (isOneOf(item, ["todowrite", "todoread", "todo_write", "update_plan"])
      ? readTodoList(item.rawInput)
      : null)
  )
}

// ─── Edits ───────────────────────────────────────────────────────────────────

/**
 * Every before/after pair a write carries, in order.
 *
 * `extractEditInput` answers the single-hunk case; this one also covers the
 * two shapes that used to fall through to a JSON dump: a `MultiEdit`, whose
 * hunks are an array nested one level down and which is therefore the *only*
 * kind of edit the transcript could not draw, and a whole-file `Write`, whose
 * "before" is the absence of a file rather than a field.
 */
export function extractEdits(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "locations">): EditInputDiff[] {
  const input = asRecord(item.rawInput)
  if (!input) return []
  const path =
    str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? item.locations[0]?.path

  const nested = input.edits ?? input.replacements ?? input.changes
  if (Array.isArray(nested)) {
    const hunks = nested.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record) return []
      const oldText = str(record.old_string) ?? str(record.oldString) ?? str(record.old_str)
      const newText = str(record.new_string) ?? str(record.newString) ?? str(record.new_str)
      if (oldText === null || newText === null) return []
      return [{
        oldText,
        newText,
        path: str(record.file_path) ?? str(record.filePath) ?? path ?? undefined,
      }]
    })
    if (hunks.length > 0) return hunks
  }

  const single = extractEditInput(item)
  if (single) return [single]

  // A create: the whole file is the "after" and there is no "before". Guarded
  // on the tool actually being a write — plenty of calls carry a `content`
  // field that is not a file body.
  const content = str(input.content) ?? str(input.new_source)
  if (content !== null && isOneOf(item, ["write", "writefile", "write_file", "create_file"])) {
    return [{ oldText: "", newText: content, path: path ?? undefined }]
  }
  return []
}

// ─── MCP calls ───────────────────────────────────────────────────────────────

/**
 * A call into an MCP server, in either of the two forms runtimes send.
 *
 * Claude Code and OpenCode flatten the server into the tool name
 * (`mcp__<server>__<tool>`) and pass the arguments as the raw input; Codex
 * keeps them apart — `mcp.<server>.<tool>` as the title, `{server, tool,
 * arguments}` as the input, `{result, error}` as the output, and `kind:
 * "execute"`, which is what used to route an MCP call into the shell layout
 * and print a `$` prompt in front of nothing.
 */
export interface McpCall {
  server: string
  tool: string
  arguments?: unknown
  result?: unknown
  error?: unknown
}

export function extractMcpCall(
  item: Pick<ToolItem, "title" | "meta" | "rawInput"> & { rawOutput?: unknown }
): McpCall | null {
  const input = asRecord(item.rawInput)
  const output = asRecord(item.rawOutput)
  const flagged = asRecord(item.meta)?.is_mcp_tool_call === true

  const server = str(input?.server)
  const tool = str(input?.tool)
  if (server && tool && (flagged || "arguments" in (input ?? {}))) {
    return {
      server,
      tool,
      arguments: input?.arguments,
      result: output?.result,
      error: output?.error ?? undefined,
    }
  }

  const name = toolIdentity(item)
  if (!name) return null
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) {
    return {
      server: dotted[1],
      tool: dotted[2],
      arguments: item.rawInput,
      result: output?.result ?? item.rawOutput,
      error: output?.error ?? undefined,
    }
  }
  const parsed = parseMcpToolName(name)
  if (!parsed) return null
  return { server: parsed.server, tool: parsed.tool, arguments: item.rawInput, result: item.rawOutput }
}

// ─── Subagents ───────────────────────────────────────────────────────────────

/**
 * Work handed to another agent. All three runtimes have one and none of them
 * agree: Claude Code's `Task`/`Agent` carries `{description, prompt,
 * subagent_type}` and reports as `kind: "think"`, OpenCode's `task` is the
 * same shape, and Codex describes a subagent's *lifecycle* through `_meta`
 * instead — a start/interact/interrupt activity against a thread id, with no
 * prompt on it at all.
 *
 * The prompt is the interesting half and it is long, so it is returned
 * separately from the one-line description rather than concatenated into it.
 */
export interface SubagentCall {
  /** Which agent — `code-reviewer`, or the leaf of Codex's agent path. */
  agentType?: string
  description?: string
  prompt?: string
  model?: string
  /** Codex only: `started` | `interacted` | `interrupted`. */
  activity?: string
  threadId?: string
}

export function extractSubagent(item: Pick<ToolItem, "title" | "meta" | "rawInput">): SubagentCall | null {
  const codex = asRecord(asRecord(asRecord(item.meta)?.codex)?.subagent)
  if (codex) {
    const path = str(codex.path)
    return {
      agentType: path?.split("/").filter(Boolean).at(-1) ?? undefined,
      activity: str(codex.activity) ?? undefined,
      threadId: str(codex.threadId) ?? undefined,
    }
  }
  const collab = asRecord(asRecord(asRecord(item.meta)?.codex)?.collaboration)
  const input = asRecord(item.rawInput)
  if (collab) {
    return {
      agentType: str(collab.tool) ?? undefined,
      prompt: str(input?.prompt) ?? undefined,
      threadId: str(collab.senderThreadId) ?? undefined,
    }
  }
  if (!isOneOf(item, ["task", "agent", "subagent", "dispatch_agent"])) return null
  return {
    agentType: str(input?.subagent_type) ?? str(input?.subagentType) ?? str(input?.agent) ?? undefined,
    description: str(input?.description) ?? undefined,
    prompt: str(input?.prompt) ?? undefined,
    model: str(input?.model) ?? undefined,
  }
}

// ─── Web search ──────────────────────────────────────────────────────────────

/**
 * A search of the web, as opposed to a search of the repo — two different acts
 * that ACP files under one `kind`. Codex reports its browsing as `kind:
 * "search"`, which sent it into the ripgrep layout: a "matches" counter over
 * prose, and `path:line:` splitting applied to sentences.
 *
 * Codex also uses this one call for three different actions (a query, opening
 * a page, finding within a page), which is why `action` is separate from
 * `query` rather than folded into it.
 */
export interface WebSearchCall {
  query?: string
  /** `search` | `openPage` | `findInPage`, when the runtime distinguishes. */
  action?: string
  url?: string
  pattern?: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  results: { title: string; url: string }[]
}

const strList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return out.length > 0 ? out : undefined
}

/** `Title (https://…)` — the one line format every runtime's web results use
    once they reach ACP, because that is what the adapters format them into. */
const HIT_RE = /^(.*?)\s*\((https?:\/\/[^\s)]+)\)\s*$/

function webResults(item: Pick<ToolItem, "rawOutput" | "content">): { title: string; url: string }[] {
  const structured = asRecord(item.rawOutput)?.results
  if (Array.isArray(structured)) {
    const hits = structured.flatMap((entry) => {
      const record = asRecord(entry)
      const title = str(record?.title)
      const url = str(record?.url)
      return title && url ? [{ title, url }] : []
    })
    if (hits.length > 0) return hits
  }
  return stringifyOutput(item.rawOutput ?? textOf(item.content), 40_000)
    .text.split("\n")
    .flatMap((line) => {
      const hit = HIT_RE.exec(line.trim())
      return hit && hit[1] ? [{ title: hit[1], url: hit[2] }] : []
    })
}

const textOf = (content: ToolItem["content"]): string =>
  content
    .map((block) => (block.type === "content" && block.content.type === "text" ? block.content.text : ""))
    .filter(Boolean)
    .join("\n")

export function extractWebSearch(item: ToolItem): WebSearchCall | null {
  const input = asRecord(item.rawInput)
  const action = asRecord(input?.action)
  const codex = str(input?.type) === "webSearch" || action !== null
  const named = isOneOf(item, ["websearch", "web_search", "search_web", "exa_search"])
  if (!codex && !named) return null

  const queries = strList(action?.queries)
  return {
    query:
      str(action?.query) ??
      (queries ? queries.join(", ") : null) ??
      str(input?.query) ??
      undefined,
    action: str(action?.type) ?? undefined,
    url: str(action?.url) ?? str(input?.url) ?? undefined,
    pattern: str(action?.pattern) ?? undefined,
    allowedDomains: strList(input?.allowed_domains),
    blockedDomains: strList(input?.blocked_domains),
    results: webResults(item),
  }
}

// ─── Questions, findings, plans, skills ──────────────────────────────────────

/**
 * The questions an `AskUserQuestion` call is asking.
 *
 * This is the *record* of a question, not the live one — a question the user
 * still has to answer arrives as an `elicitation/create` request and is drawn
 * by `elicitation-form.tsx`. What lands in the transcript afterwards is the
 * tool call, and left generic it renders as a nested JSON blob of the exact
 * thing the user was just shown a form for.
 */
export interface ToolQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export function extractQuestions(item: Pick<ToolItem, "title" | "meta" | "rawInput">): ToolQuestion[] | null {
  if (!isOneOf(item, ["askuserquestion", "ask_user_question", "question", "ask"])) return null
  const raw = asRecord(item.rawInput)?.questions
  if (!Array.isArray(raw)) return null
  const questions = raw.flatMap((entry) => {
    const record = asRecord(entry)
    const question = str(record?.question)
    if (!question) return []
    const options = Array.isArray(record?.options)
      ? record.options.flatMap((option) => {
          const opt = asRecord(option)
          const label = str(opt?.label)
          return label ? [{ label, description: str(opt?.description) ?? undefined }] : []
        })
      : []
    return [{
      question,
      header: str(record?.header) ?? undefined,
      multiSelect: record?.multiSelect === true,
      options,
    }]
  })
  return questions.length > 0 ? questions : null
}

/** A `ReportFindings` call: a review's results, which are a table and not prose. */
export interface ToolFinding {
  file: string
  line?: number
  summary: string
  category?: string
  verdict?: string
  severity?: string
}

export function extractFindings(item: Pick<ToolItem, "title" | "meta" | "rawInput">): ToolFinding[] | null {
  if (!isOneOf(item, ["reportfindings", "report_findings"])) return null
  const raw = asRecord(item.rawInput)?.findings
  if (!Array.isArray(raw)) return null
  // An empty array is a real answer — "reviewed, found nothing" — so it is
  // returned as an empty list rather than as null.
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    const file = str(record?.file)
    const summary = str(record?.short_summary) ?? str(record?.summary)
    if (!file || !summary) return []
    return [{
      file,
      line: typeof record?.line === "number" ? record.line : undefined,
      summary,
      category: str(record?.category) ?? undefined,
      verdict: str(record?.verdict) ?? undefined,
      severity: str(record?.severity) ?? undefined,
    }]
  })
}

/** An `ExitPlanMode` call: the plan the agent is asking permission to run. It
    is markdown, and it is the entire point of the call. */
export function extractPlanProposal(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "toolKind">): string | null {
  if (item.toolKind !== "switch_mode" && !isOneOf(item, ["exitplanmode", "exit_plan_mode"])) {
    return null
  }
  const input = asRecord(item.rawInput)
  return str(input?.plan) ?? str(input?.markdown) ?? null
}

/** A plan proposal carried by a *live* permission request, not a settled tool
    item. Same condition as `extractPlanProposal` but reads a `ToolCallUpdate`
    — the shape ACP uses on the pending question — where the kind is `kind`, not
    `toolKind`. A codex plan approval arrives exactly like this: kind
    `switch_mode`, title "Implement this plan?", `rawInput: { plan: markdown }`.
    Without this the approval card rendered the plan as a raw JSON dump. */
export function extractPlanProposalFromPermission(
  toolCall: Pick<acp.ToolCallUpdate, "kind" | "title" | "name" | "rawInput">
): string | null {
  if (toolCall.kind !== "switch_mode" && !/^(exit_plan_mode|exitplanmode|plan)$/.test(toolCall.name?.toLowerCase() ?? "")) {
    return null
  }
  const input = asRecord(toolCall.rawInput)
  return str(input?.plan) ?? str(input?.markdown) ?? null
}

/** A `Skill` load: which packaged workflow the agent pulled in, and with what. */
export interface SkillLoad {
  name: string
  args?: string
}

export function extractSkill(item: Pick<ToolItem, "title" | "meta" | "rawInput">): SkillLoad | null {
  if (!isOneOf(item, ["skill", "loadskill", "load_skill"])) return null
  const input = asRecord(item.rawInput)
  const name = str(input?.skill) ?? str(input?.name)
  return name ? { name, args: str(input?.args) ?? undefined } : null
}

// ─── Search options ──────────────────────────────────────────────────────────

/**
 * The flags a repo search actually ran with. Claude Code's `Grep` carries nine
 * of them (`-i`, `-n`, `-A`/`-B`/`-C`, `output_mode`, `head_limit`, `glob`,
 * `type`, `multiline`) as separate input keys, and a layout that reads only
 * `pattern` and `path` silently claims a case-insensitive search with two
 * lines of context was a plain one.
 */
export function searchFlags(item: Pick<ToolItem, "rawInput">): string[] {
  const input = asRecord(item.rawInput)
  if (!input) return []
  const flags: string[] = []
  if (input["-i"] === true) flags.push("case-insensitive")
  if (input.multiline === true) flags.push("multiline")
  for (const key of ["-A", "-B", "-C"] as const) {
    if (typeof input[key] === "number") flags.push(`${key} ${input[key]}`)
  }
  const mode = str(input.output_mode)
  if (mode && mode !== "content") flags.push(mode.replace(/_/g, " "))
  const type = str(input.type)
  if (type) flags.push(`type ${type}`)
  if (typeof input.head_limit === "number") flags.push(`first ${input.head_limit}`)
  return flags
}

// ─── View selection ──────────────────────────────────────────────────────────

/**
 * Which layout a call gets. One switch, evaluated in priority order, so the
 * transcript component has a single place to dispatch on and the ordering
 * decisions (a todo list beats its `think` kind; a terminal beats everything,
 * because its content block is a handle rather than a payload) are stated once
 * here rather than implied by the nesting of ifs in a component.
 *
 * The tail of the list is the ACP `kind` — unchanged, and still the answer for
 * every agent that sends one and every tool nobody has taught this file about.
 */
export type ToolView =
  | "todos"
  | "edit"
  | "terminal"
  | "mcp"
  | "subagent"
  | "websearch"
  | "questions"
  | "findings"
  | "plan"
  | "skill"
  | "execute"
  | "read"
  | "search"
  | "fetch"
  | "generic"

export function toolViewOf(item: ToolItem): ToolView {
  // A diff is the point of the call whatever produced it, and an edit's own
  // content block is already the diff — so both edit paths answer first.
  if (item.content.some((block) => block.type === "diff")) return "edit"
  if (extractEdits(item).length > 0) return "edit"
  if (extractTodos(item)) return "todos"
  if (extractPlanProposal(item) !== null) return "plan"
  if (extractQuestions(item)) return "questions"
  if (extractFindings(item)) return "findings"
  if (extractSubagent(item)) return "subagent"
  if (extractSkill(item)) return "skill"
  if (extractWebSearch(item)) return "websearch"
  if (extractMcpCall(item)) return "mcp"
  // Only after the specialised views: Codex files a terminal under `execute`
  // and an MCP call under `execute` too, and both want their own layout.
  if (hasTerminalContent(item)) return "terminal"

  const kind = toolKindOf(item)
  if (kind === "execute" || kind === "read" || kind === "search" || kind === "fetch") return kind
  return "generic"
}

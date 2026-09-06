/* ── Shell commands ── heredoc splitting and payload languages. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"

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

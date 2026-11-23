/* ── A shell run's output, read rather than dumped ──
   What a command printed used to be one `<pre>` in muted grey: a ping summary,
   a config grep and an aligned CLI table all ran together, wrapped lines broke
   the table's columns, and the one line that said "100% packet loss" looked
   like every other line.

   This draws the same bytes as numbered lines with four things added, all of
   them read off the text and none of them guessed past it:

   — **Sections.** A line that is only a marker and a label (`== host`,
     `--- conf`, `### step`) is what a script echoes to separate its parts, so
     it is drawn as a heading. Off for diff output, where `--- a/file` is data.
   — **Tone.** A line naming an error or a warning is tinted; the rest stays
     the reading colour. A "0 errors" is not an error.
   — **Wrap is a choice.** Unwrapped by default, because column-aligned output
     (a table, `ls -l`, a status grid) is only legible with its columns intact;
     the toggle wraps for prose-shaped logs and long single lines.
   — **Terminal noise is dropped**: ANSI colour codes and the overwritten half
     of a `\r` progress line are not text anyone printed for a reader. */
import * as React from "react"
import { WrapTextIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { cn } from "@/lib/utils"

type Tone = "error" | "warn" | null
type Line = { kind: "line"; text: string; tone: Tone; n: number } | { kind: "section"; label: string; n: number }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const SECTION = /^\s*(?:={2,}|-{3,}|#{2,4}|>{2,}|\*{3,})\s+(\S.*?)\s*(?:={2,}|-{3,}|#{2,4}|<{2,}|\*{3,})?\s*$/
const LOOKS_LIKE_DIFF = /^(?:@@ |diff --git |\+\+\+ )/m
const ZERO_COUNT = /\b0 (?:errors?|failures?|failed|warnings?)\b/gi
const ERROR =
  /\b(?:errors?|err!|failed|failure|fatal|denied|refused|unreachable|panic|exception|traceback|segmentation fault|no such file|not found|cannot|can't)\b|\b100% packet loss\b/i
const WARN = /\b(?:warn(?:ing)?s?|deprecated)\b/i

/** Strip what a terminal would have consumed rather than shown. */
export function cleanTerminalText(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      // A carriage return redraws the line: only what was written last shows.
      const parts = line.replace(/\r$/, "").split("\r")
      return parts[parts.length - 1]
    })
    .join("\n")
}

function toneOf(text: string): Tone {
  const probe = text.replace(ZERO_COUNT, "")
  if (ERROR.test(probe)) return "error"
  if (WARN.test(probe)) return "warn"
  return null
}

/* ── Line highlighting ──
   A shell's output has no grammar to hand to Shiki, but most of what a command
   prints is a handful of shapes: a `key = value` or `Key: value` pair, a
   grep's `12:` prefix, a comment, an address, a path, a figure with its unit.
   Those are coloured with the editor's own `--code-*` tokens, so the output
   reads in the same palette as fenced code and moves with a custom theme.
   Anything unrecognised stays the reading colour — a wrong guess on a log line
   is worse than no colour. */
const C = {
  key: "text-(--code-property)",
  string: "text-(--code-string)",
  number: "text-(--code-number)",
  section: "text-(--code-function)",
  keyword: "text-(--code-keyword)",
  path: "text-(--code-type)",
  punct: "text-(--code-punctuation)",
  comment: "text-(--code-comment) italic",
}
const GREP_PREFIX = /^(\S+?:)?(\d+)([:-])(?=\S|$)/
const KEY = /^(\s*)([A-Za-z_][\w./ -]{0,38}?)(\s*)(=|:)(?=\s|$)/
const TOKEN = new RegExp(
  [
    String.raw`(?<string>"[^"\n]*"|'[^'\n]*')`,
    String.raw`(?<url>\bhttps?:\/\/[^\s<>"']+)`,
    String.raw`(?<ip>\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?::\d{1,5})?\b)`,
    String.raw`(?<path>(?<![\w.])(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)*)`,
    String.raw`(?<section>\[[^\]\n]{1,60}\])`,
    String.raw`(?<number>(?<![\w.])[-+]?\d+(?:\.\d+)?(?:%|ms|us|ns|s|[kKMGT]i?B|B)?(?![\w.]))`,
    String.raw`(?<keyword>\b(?:true|false|yes|no|on|off|null|none|ok|OK|up|down|active|inactive|enabled|disabled|running|stopped|Avail|Unavail)\b)`,
  ].join("|"),
  "g"
)

function tokenize(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0
    if (index > last) out.push(text.slice(last, index))
    const groups = match.groups ?? {}
    const kind = (Object.keys(groups) as (keyof typeof groups)[]).find((name) => groups[name] !== undefined)
    const cls =
      kind === "string" ? C.string
      : kind === "url" ? cn(C.string, "underline decoration-current/30 underline-offset-2")
      : kind === "ip" || kind === "number" ? C.number
      : kind === "path" ? C.path
      : kind === "section" ? C.section
      : C.keyword
    out.push(
      <span key={`${key}-${index}`} className={cls}>
        {match[0]}
      </span>
    )
    last = index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function highlightShellLine(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let rest = text
  const grep = GREP_PREFIX.exec(rest)
  if (grep) {
    out.push(
      <span key="g" className={C.punct}>
        {grep[0]}
      </span>
    )
    rest = rest.slice(grep[0].length)
  }
  const trimmed = rest.trimStart()
  if (trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("//")) {
    out.push(
      <span key="c" className={C.comment}>
        {rest}
      </span>
    )
    return out
  }
  const pair = KEY.exec(rest)
  if (pair) {
    out.push(
      pair[1],
      <span key="k" className={C.key}>
        {pair[2]}
      </span>,
      pair[3],
      <span key="o" className={C.punct}>
        {pair[4]}
      </span>
    )
    rest = rest.slice(pair[0].length)
  }
  out.push(...tokenize(rest, "t"))
  return out
}

export function readShellLines(text: string): Line[] {
  const body = text.replace(/\n+$/, "")
  if (!body) return []
  const sections = !LOOKS_LIKE_DIFF.test(body)
  return body.split("\n").map((raw, index) => {
    const n = index + 1
    const match = sections ? SECTION.exec(raw) : null
    if (match) return { kind: "section", label: match[1], n }
    return { kind: "line", text: raw, tone: toneOf(raw), n }
  })
}

export function ShellOutput({
  output,
  whole,
  failed = false,
  footer,
  scrollClassName,
}: {
  /** What is drawn — possibly cut by the Show-all cap. */
  output: string
  /** Every byte that arrived, for the copy and the line count. */
  whole?: string
  failed?: boolean
  /** Drawn under the lines, inside the pane (the Show-all button). */
  footer?: React.ReactNode
  /** The scroller's height cap — the caller's `PANE_MAX_H`. */
  scrollClassName?: string
}) {
  const [wrap, setWrap] = React.useState(false)
  const shown = React.useMemo(() => readShellLines(cleanTerminalText(output)), [output])
  const full = React.useMemo(() => cleanTerminalText(whole ?? output).replace(/\n+$/, ""), [whole, output])
  const total = full ? full.split("\n").length : 0
  const gutter = `${String(shown.length).length + 1}ch`

  return (
    <div className="border-t border-inherit">
      <div className="flex items-center gap-1 py-0.5 ps-3 pe-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          Output
          <span className="tabular-nums">
            {" · "}
            {total} {total === 1 ? "line" : "lines"}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          title={wrap ? "Don't wrap lines" : "Wrap long lines"}
          onClick={() => setWrap((value) => !value)}
          className={cn("text-muted-foreground hover:text-foreground", wrap && "bg-background text-foreground")}
        >
          <WrapTextIcon />
        </Button>
        <CopyButton
          text={full}
          size="icon-xs"
          aria-label="Copy output"
          title="Copy output"
          className="text-muted-foreground hover:text-foreground"
        />
      </div>
      <div
        role="region"
        aria-label="Command output"
        tabIndex={0}
        className={cn(
          scrollClassName,
          "overflow-auto overscroll-x-contain outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        )}
      >
        <div
          className={cn(
            "pb-2 font-mono text-xs leading-relaxed",
            wrap ? "w-full" : "w-max min-w-full",
            failed ? "text-destructive" : "text-foreground/85"
          )}
          style={{ "--gutter": gutter } as React.CSSProperties}
        >
          {shown.map((line) =>
            line.kind === "section" ? (
              <div key={line.n} role="heading" aria-level={4} className="mt-2 flex items-center gap-2 pe-3 first:mt-1">
                <span aria-hidden className="box-content w-(--gutter) shrink-0 ps-3 select-none" />
                <span className="font-sans text-[0.7rem] font-semibold tracking-wide text-foreground uppercase">
                  {line.label}
                </span>
                <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
              </div>
            ) : (
              <div
                key={line.n}
                className={cn(
                  "flex",
                  line.tone === "error" && !failed && "bg-destructive/10 text-destructive",
                  line.tone === "warn" && "bg-warning/10 text-warning"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "box-content w-(--gutter) shrink-0 ps-3 pe-3 text-end tabular-nums select-none",
                    line.tone ? "opacity-70" : "text-muted-foreground/50"
                  )}
                >
                  {line.n}
                </span>
                <span className={cn("pe-3", wrap ? "min-w-0 flex-1 break-words whitespace-pre-wrap" : "whitespace-pre")}>
                  {/* A toned line keeps one colour: the tint is the signal, and
                      a failed run's output stays uncoloured like any error. */}
                  {!line.text ? " " : line.tone || failed ? line.text : highlightShellLine(line.text)}
                </span>
              </div>
            )
          )}
        </div>
      </div>
      {footer}
    </div>
  )
}

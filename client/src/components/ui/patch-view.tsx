/* ── Unified patch ──
   Draws what `git diff` printed, hunk by hunk, and hands each hunk back as a
   patch of its own so the review panel can stage or discard one at a time.
   `DiffView` (diff-view.tsx) is the other renderer — it computes a diff from
   two texts for the transcript's edit tools. This one never computes: git
   already did, and the hunk boundaries git chose are the ones `git apply`
   wants back, so recomputing them would be a second answer to the same
   question. */
import * as React from "react"

import { cn } from "@/lib/utils"

export interface PatchHunk {
  header: string
  lines: { type: "add" | "del" | "ctx" | "meta"; text: string }[]
  /** The hunk as a patch git will apply on its own: file header + this hunk. */
  patch: string
}

export interface ParsedPatch {
  /** `diff --git … ` through the last `+++` line, kept verbatim. */
  fileHeader: string
  hunks: PatchHunk[]
  binary: boolean
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

/** One file's patch (the server asks git for one path at a time). */
export function parsePatch(text: string): ParsedPatch {
  const lines = text.replace(/\n$/, "").split("\n")
  const headerLines: string[] = []
  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let binary = false
  for (const line of lines) {
    if (HUNK_RE.test(line)) {
      current = { header: line, lines: [], patch: "" }
      hunks.push(current)
      continue
    }
    if (!current) {
      if (line.startsWith("Binary files")) binary = true
      headerLines.push(line)
      continue
    }
    const type =
      line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("\\") ? "meta" : "ctx"
    current.lines.push({ type, text: type === "meta" ? line : line.slice(1) })
  }
  const fileHeader = headerLines.join("\n")
  for (const hunk of hunks) {
    const body = hunk.lines
      .map((l) => (l.type === "add" ? `+${l.text}` : l.type === "del" ? `-${l.text}` : l.type === "ctx" ? ` ${l.text}` : l.text))
      .join("\n")
    hunk.patch = `${fileHeader}\n${hunk.header}\n${body}\n`
  }
  return { fileHeader, hunks, binary }
}

const SIGN = { add: "+", del: "−", ctx: " ", meta: " " } as const

export function PatchView({
  patch,
  className,
  onStageHunk,
  onDiscardHunk,
  busy,
}: {
  patch: string
  className?: string
  /** Absent means the hunk buttons are not drawn (a finished turn read
      against its own trees can still be staged — the preimage just has to
      match what is on disk, and git says so when it does not). */
  onStageHunk?: (hunk: PatchHunk) => void
  onDiscardHunk?: (hunk: PatchHunk) => void
  busy?: boolean
}) {
  const parsed = React.useMemo(() => parsePatch(patch), [patch])
  if (parsed.binary) {
    return <p className={cn("px-3 py-4 text-xs text-muted-foreground", className)}>Binary file — nothing to show line by line.</p>
  }
  if (parsed.hunks.length === 0) {
    return <p className={cn("px-3 py-4 text-xs text-muted-foreground", className)}>No textual change.</p>
  }
  return (
    <div className={cn("font-mono text-xs leading-5", className)}>
      {parsed.hunks.map((hunk, index) => (
        <section key={index} className="border-b border-border/40 last:border-b-0">
          <header className="sticky top-0 z-10 flex items-center gap-2 border-y border-border/40 bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur">
            <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
            {onStageHunk && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onStageHunk(hunk)}
                className="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              >
                Stage hunk
              </button>
            )}
            {onDiscardHunk && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onDiscardHunk(hunk)}
                className="shrink-0 rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                Discard hunk
              </button>
            )}
          </header>
          <pre className="min-w-max py-0.5">
            {hunk.lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "flex whitespace-pre",
                  line.type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  line.type === "del" && "bg-red-500/10 text-red-700 dark:text-red-300",
                  line.type === "meta" && "text-muted-foreground/60"
                )}
              >
                <span aria-hidden className={cn("w-5 shrink-0 text-center select-none", line.type === "ctx" && "text-muted-foreground/30")}>
                  {SIGN[line.type]}
                </span>
                <span className={cn("pe-3", line.type === "ctx" && "text-muted-foreground")}>{line.text || " "}</span>
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  )
}

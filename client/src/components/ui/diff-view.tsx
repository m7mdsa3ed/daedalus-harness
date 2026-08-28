/* ── Diff ──
   A real line diff, not an old-block-then-new-block dump: an edit that touches
   three lines of a 200-line file should show three lines, not 400.

   Line-level LCS with a hard bail-out, plus unchanged runs collapsed to a few
   lines of context. No dependency — the algorithm is thirty lines and a diff
   library is not.

   Ported from /var/www/mawared-off/social-live-agent/ai-agent-web. */
import * as React from "react"
import { cn } from "@/lib/utils"

type Op = { type: "eq" | "add" | "del"; text: string }
type Row = Op | { type: "skip"; count: number }

/* The DP table is O(n·m) cells. Past this a diff is not something anyone is
   reading line by line, so fall back to "all of the old, then all of the new"
   rather than locking the tab up for a fancier answer nobody asked for. */
const MAX_LINES = 1500
const MAX_CELLS = 4_000_000

function diffLines(oldText: string, newText: string): Op[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length > MAX_LINES || b.length > MAX_LINES || a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ]
  }

  const n = a.length
  const m = b.length
  // dp[i][j] = length of the LCS of a[i..] and b[j..].
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] })
      i++
    } else {
      ops.push({ type: "add", text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] })
  while (j < m) ops.push({ type: "add", text: b[j++] })
  return ops
}

/** Collapse long unchanged runs to a few lines of context around each change. */
function withContext(ops: Op[], context = 3): Row[] {
  const out: Row[] = []
  let run: Op[] = []
  let started = false

  const flush = (isEnd: boolean, isStart: boolean) => {
    const short =
      run.length <= context * 2 + 1 ||
      (isStart && run.length <= context) ||
      (isEnd && run.length <= context)
    if (short) {
      out.push(...run)
    } else {
      const head = isStart ? [] : run.slice(0, context)
      const tail = isEnd ? [] : run.slice(-context)
      out.push(...head, { type: "skip", count: run.length - head.length - tail.length }, ...tail)
    }
    run = []
  }

  for (const op of ops) {
    if (op.type === "eq") {
      run.push(op)
    } else {
      if (run.length) flush(false, !started)
      started = true
      out.push(op)
    }
  }
  if (run.length) flush(true, !started)
  return out
}

const SIGN = { add: "+", del: "−", eq: " " } as const

export function DiffView({
  oldText,
  newText,
  path,
  className,
  split = false,
}: {
  oldText?: string | null
  newText: string
  path?: string
  className?: string
  /** Render old | new side by side instead of a unified list. */
  split?: boolean
}) {
  const rows = React.useMemo(
    () => withContext(diffLines(oldText ?? "", newText)),
    [oldText, newText]
  )
  const added = rows.filter((row) => row.type === "add").length
  const removed = rows.filter((row) => row.type === "del").length

  return (
    <div className={cn("overflow-hidden rounded-md border border-border/50", className)}>
      {(path || added || removed) && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
          {path && <span className="min-w-0 flex-1 truncate text-muted-foreground">{path}</span>}
          <span className="ml-auto shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
            +{added}
          </span>
          <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{removed}</span>
        </div>
      )}
      <div className="max-h-80 overflow-auto">
        {split ? (
          /* Two columns: deletions on the left, additions on the right, unchanged
              lines on both. A row that only exists on one side leaves the other
              cell blank so the two halves stay aligned line for line. */
          <div className="grid grid-cols-[1fr_1fr] font-mono text-xs leading-5">
            {rows.map((row, index) =>
              row.type === "skip" ? (
                <div
                  key={index}
                  className="col-span-2 my-0.5 border-y border-border/40 bg-muted/30 px-2.5 py-0.5 text-[10px] text-muted-foreground/60 select-none"
                >
                  ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
                </div>
              ) : (
                <DiffSplitRow key={index} row={row} />
              )
            )}
          </div>
        ) : (
          /* Same body size as the rest of the transcript; `leading-5` stays, a
              diff wants a touch more room between lines than prose does. */
          <pre className="min-w-max py-1 font-mono text-xs leading-5">
            {rows.map((row, index) =>
              row.type === "skip" ? (
                <div
                  key={index}
                  className="my-0.5 border-y border-border/40 bg-muted/30 px-2.5 py-0.5 text-[10px] text-muted-foreground/60 select-none"
                >
                  ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
                </div>
              ) : (
                <div
                  key={index}
                  className={cn(
                    "flex whitespace-pre",
                    row.type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    row.type === "del" && "bg-red-500/10 text-red-700 dark:text-red-300"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "w-5 shrink-0 text-center select-none",
                      row.type === "eq" && "text-muted-foreground/30"
                    )}
                  >
                    {SIGN[row.type]}
                  </span>
                  <span className={cn("pe-3", row.type === "eq" && "text-muted-foreground")}>
                    {row.text || " "}
                  </span>
                </div>
              )
            )}
          </pre>
        )}
      </div>
    </div>
  )
}

/** One row of a split diff: the left cell holds deletions + unchanged lines, the
 *  right holds additions + unchanged lines, and the side a row doesn't belong to
 *  is left blank so the two columns stay aligned. */
function DiffSplitRow({ row }: { row: Row }) {
  const left = row.type === "del" || row.type === "eq" ? row : null
  const right = row.type === "add" || row.type === "eq" ? row : null
  return (
    <>
      <div
        className={cn(
          "whitespace-pre pe-3",
          left?.type === "del" && "bg-red-500/10 text-red-700 dark:text-red-300",
          left?.type === "eq" && "text-muted-foreground"
        )}
      >
        {left ? (left.type === "eq" ? left.text : `- ${left.text}`) : " "}
      </div>
      <div
        className={cn(
          "whitespace-pre ps-3",
          right?.type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          right?.type === "eq" && "text-muted-foreground"
        )}
      >
        {right ? (right.type === "eq" ? right.text : `+ ${right.text}`) : " "}
      </div>
    </>
  )
}

/* ── How far the branch is from its upstream ──
   The branch *control* moved to `branch-picker.tsx` — one switcher for the
   whole app, shared with the composer's popover. What is left here is the
   reading beside it: a status that already answers "is my work pushed?" and
   does not say so is a panel that makes you open a terminal to find out. */
import type { GitStatus } from "@/lib/workspace/git-api"

/** Ahead of / behind the upstream. The status has always answered this and the
    panel has never said it, so "is my work pushed?" meant a terminal. Nothing
    is drawn when there is no upstream — a zero would claim there was one. */
export function Tracking({ status }: { status: GitStatus | null }) {
  if (!status?.upstream || (status.ahead === 0 && status.behind === 0)) return null
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
      title={`${status.ahead} ahead of and ${status.behind} behind ${status.upstream}`}
    >
      {status.ahead > 0 && <span>↑{status.ahead}</span>}
      {status.ahead > 0 && status.behind > 0 && " "}
      {status.behind > 0 && <span>↓{status.behind}</span>}
    </span>
  )
}

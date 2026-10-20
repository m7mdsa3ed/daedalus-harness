/* ── The vocabulary source control is read in ──
   What every part of the view agrees on: what a repository's read is worth so
   far, and the one icon button the toolbar, the header and the rows all use.
   Nothing here talks to the server and nothing here holds state.

   What a *row* is no longer lives here: the four-groups-of-rows model it used
   to describe is gone, and one entry per path with a staged tri-state is
   `lib/workspace/working-set.ts`. */
import * as React from "react"
import { PlusSignIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useCoarsePointer } from "@/hooks/use-device"
import { cn } from "@/lib/utils"
import type { GitStatus } from "@/lib/workspace/git-api"

export interface RepoState {
  status: GitStatus | null
  error: string | null
  loading: boolean
}

/** An icon button with its label as a tooltip — the row actions are icon-only
    for room, and an icon with no name is a guess. The tap target is 44px on a
    finger and 24px with a mouse; both draw the same 14px glyph, so the row's
    rhythm does not change with the pointer. */
export function IconAction({
  label,
  icon,
  onClick,
  disabled,
  className,
  variant = "ghost",
  loading,
}: {
  label: string
  icon: typeof PlusSignIcon
  onClick: () => void
  disabled?: boolean
  className?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  loading?: boolean
}) {
  const coarse = useCoarsePointer()
  return (
    <Button
      title={label}
      variant={variant}
      size="icon-xs"
      disabled={disabled}
      loading={loading}
      onClick={onClick}
      aria-label={label}
      className={cn(coarse ? "size-11" : "size-6", className)}
    >
      {loading ? <Spinner className="size-3.5" /> : <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />}
    </Button>
  )
}

/** `+12 −3` — drawn only where git counted something. */
export function LineCounts({
  insertions,
  deletions,
  className,
}: {
  insertions?: number | null
  deletions?: number | null
  className?: string
}) {
  if (!insertions && !deletions) return null
  return (
    <span className={cn("shrink-0 font-mono text-xs tabular-nums", className)}>
      {!!insertions && <span className="text-success">+{insertions}</span>}
      {!!insertions && !!deletions && " "}
      {!!deletions && <span className="text-destructive">−{deletions}</span>}
    </span>
  )
}

/** A status letter's colour — the working set's and the Review list's. */
export const MARK_CLASS: Record<string, string> = {
  A: "text-success",
  "?": "text-success",
  M: "text-warning",
  D: "text-destructive",
  U: "text-destructive",
  R: "text-primary",
}

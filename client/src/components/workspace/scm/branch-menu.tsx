/* ── The branch, and how far it is from its upstream ──
   **A branch is a control, not a caption.** The header's branch name opens the
   list and switches, and creates one from the same menu; ahead/behind is drawn
   beside it because a status that already answers it and does not say so is a
   panel that makes you open a terminal to find out. Stashes and history are the
   sections below (`scm-log.tsx`) — both were already routes with no surface. */
import * as React from "react"
import { GitBranchIcon, PlusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { usePrompt } from "@/components/prompt-dialog"
import { useCoarsePointer } from "@/hooks/use-device"
import { describeError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { gitBranches, type GitStatus } from "@/lib/workspace/git-api"

/* ── The branch ──
   The header's branch name, and the list behind it. Branches are read **when
   the menu opens** and not with the status: a repository with two thousand refs
   would otherwise pay for them on every watch burst, to draw one name.

   Switching is `checkout`, which the server already refuses when the worktree
   would be clobbered — so the panel does not second-guess it, and git's own
   refusal is what the section prints. */
export function BranchMenu({
  projectId,
  repo,
  branch,
  unborn,
  disabled,
  onCheckout,
}: {
  projectId: string
  repo: string
  branch: string
  unborn: boolean
  disabled: boolean
  onCheckout: (branch: string, create: boolean) => void
}) {
  const settings = useServer()
  const prompt = usePrompt()
  const coarse = useCoarsePointer()
  const [branches, setBranches] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    setBranches(null)
    setError(null)
    void gitBranches(settings, projectId, repo || undefined)
      .then((list) => setBranches(list.branches))
      .catch((err: unknown) => setError(describeError(err).title))
  }, [projectId, repo, settings])

  const create = async () => {
    const name = await prompt({
      title: "New branch",
      description: `Branched from ${branch}, and checked out.`,
      placeholder: "feature/…",
      confirmLabel: "Create",
      maxLength: 200,
    })
    if (name) onCheckout(name, true)
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            title={`On ${branch} — switch or create a branch`}
            className={cn(
              "min-w-0 shrink gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground data-popup-open:bg-accent",
              coarse && "min-h-11"
            )}
          >
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{branch}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-auto min-w-56">
        <DropdownMenuItem onClick={() => void create()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          Create a branch…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Before the first commit there is no branch to switch *to*: the one
            you are on does not exist as a ref yet. */}
        {unborn ? (
          <DropdownMenuLabel>No commits yet, so nothing to switch to.</DropdownMenuLabel>
        ) : error ? (
          <DropdownMenuLabel className="text-destructive">{error}</DropdownMenuLabel>
        ) : branches === null ? (
          <PanelRowsSkeleton rows={4} className="space-y-1.5 p-1.5" />
        ) : branches.length === 0 ? (
          <DropdownMenuLabel>No branches.</DropdownMenuLabel>
        ) : (
          branches.map((name) => (
            <DropdownMenuItem
              key={name}
              disabled={name === branch}
              onClick={() => onCheckout(name, false)}
            >
              <HugeiconsIcon
                icon={name === branch ? Tick02Icon : GitBranchIcon}
                strokeWidth={2}
                className={name === branch ? undefined : "opacity-40"}
              />
              <span className="min-w-0 truncate font-mono text-xs">{name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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

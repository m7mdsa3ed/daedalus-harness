/* ── Logical commits, reviewed ──
   The commit box's second AI action: the whole working set split into a
   sequence of commits by the same profile that drafts a message. A plan is
   several writes to history, so it is drawn for review before anything lands -
   each message editable, each file movable to another commit or left out, and
   a commit removed hands its files to "Left uncommitted". Landing it is one
   `commit-plan` write, which the server validates whole first. */
import * as React from "react"
import { Delete02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/busy-button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { IconAction } from "@/components/workspace/scm/shared"
import type { PlannedCommit } from "@/lib/workspace/git-api"

const LEFT_OUT = "none"

export function CommitPlanDialog({
  plan,
  branch,
  busy,
  onOpenChange,
  onCommit,
}: {
  /** The drafted plan; null keeps the dialog closed. */
  plan: { commits: PlannedCommit[]; unplanned: string[] } | null
  branch: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  /** Answers false when the plan did not land, so the dialog stays open. */
  onCommit: (commits: PlannedCommit[]) => Promise<boolean>
}) {
  const [commits, setCommits] = React.useState<PlannedCommit[]>([])
  const [leftOut, setLeftOut] = React.useState<string[]>([])

  React.useEffect(() => {
    if (!plan) return
    setCommits(plan.commits)
    setLeftOut(plan.unplanned)
  }, [plan])

  const move = (path: string, to: string) => {
    setCommits((current) =>
      current.map((commit, index) => {
        const rest = commit.paths.filter((p) => p !== path)
        return String(index) === to ? { ...commit, paths: [...rest, path] } : { ...commit, paths: rest }
      })
    )
    setLeftOut((current) => (to === LEFT_OUT ? [...current.filter((p) => p !== path), path] : current.filter((p) => p !== path)))
  }

  const remove = (index: number) => {
    setLeftOut((current) => [...current, ...commits[index]!.paths])
    setCommits((current) => current.filter((_, i) => i !== index))
  }

  /* A commit emptied by moves is dropped on landing rather than refused: it
     says nothing anyone would want in history. */
  const landing = commits.filter((commit) => commit.paths.length > 0)
  const ready = landing.length > 0 && landing.every((commit) => commit.message.trim())

  const fileRow = (path: string, at: string) => (
    <li key={path} className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
      <Select value={at} onValueChange={(value) => move(path, value as string)}>
        <SelectTrigger size="sm" aria-label={`Move ${path}`} className="h-6 w-32 shrink-0 text-xs">
          <SelectValue>{at === LEFT_OUT ? "Leave out" : `Commit ${Number(at) + 1}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {commits.map((_, index) => (
            <SelectItem key={index} value={String(index)}>Commit {index + 1}</SelectItem>
          ))}
          <SelectItem value={LEFT_OUT}>Leave out</SelectItem>
        </SelectContent>
      </Select>
    </li>
  )

  return (
    <ResponsiveDialog open={!!plan} onOpenChange={onOpenChange} tall>
      <ResponsiveDialogContent className="sm:max-w-2xl" bodyClassName="gap-3">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Logical commits</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Committed to {branch} in this order, each with only its own files. Edit a message or move a file before committing.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {commits.map((commit, index) => (
          <section key={index} className="flex flex-col gap-1.5 rounded-lg border p-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="mr-auto">Commit {index + 1}</span>
              <IconAction label={`Remove commit ${index + 1}`} icon={Delete02Icon} disabled={busy} onClick={() => remove(index)} />
            </div>
            <Textarea
              value={commit.message}
              onChange={(event) => setCommits((current) => current.map((c, i) => (i === index ? { ...c, message: event.target.value } : c)))}
              aria-label={`Commit ${index + 1} message`}
              rows={Math.min(5, Math.max(2, commit.message.split("\n").length))}
              className="min-h-0 resize-y font-mono text-xs"
            />
            {commit.paths.length > 0 ? (
              <ul className="flex flex-col gap-1">{commit.paths.map((path) => fileRow(path, String(index)))}</ul>
            ) : (
              <p className="text-xs text-muted-foreground">No files - skipped.</p>
            )}
          </section>
        ))}
        {leftOut.length > 0 && (
          <section className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
            <span className="text-xs font-medium text-muted-foreground">Left uncommitted</span>
            <ul className="flex flex-col gap-1">{leftOut.map((path) => fileRow(path, LEFT_OUT))}</ul>
          </section>
        )}
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            loading={busy}
            disabled={busy || !ready}
            onClick={() => void onCommit(landing).then((ok) => ok && onOpenChange(false))}
          >
            {`Make ${landing.length} ${landing.length === 1 ? "commit" : "commits"}`}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

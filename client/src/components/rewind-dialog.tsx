import * as React from "react"
import { History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Spinner } from "@/components/ui/spinner"

export type RewindScope = "conversation" | "files" | "both"

/* ── Rewind to before a turn ──
   A confirm with a scope: the conversation (fork the agent session back and
   respawn), the files (restore the worktree to the turn's start tree), or
   both. Everything from the named turn onward is discarded — the journal is
   cleared server-side and the thread reattaches from 0, so this reads as a
   destructive confirm even though the dialog is small.

   `canRewindConversation` is false on agents without a rewind door
   (opencode, daedalus): the conversation row is dropped rather than disabled,
   because a control that can never work on this thread is one you have to
   hunt past — and the files row stays, since a restore needs no door. */
export function RewindDialog({
  open,
  onOpenChange,
  turnLabel,
  turnPreview,
  canRewindConversation,
  hasFiles,
  defaultScope,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Turn 4" — the ordinal from the rail, so the dialog names what it cuts. */
  turnLabel: string
  /** The prompt that opened the turn, truncated — how you recognise it. */
  turnPreview: string
  canRewindConversation: boolean
  /** False when the turn has no file snapshot, which is when a files restore
      would 404 — the row is disabled and says why, not dropped, because the
      turn exists and the missing snapshot is the fact worth showing. */
  hasFiles: boolean
  defaultScope: RewindScope
  busy: boolean
  onConfirm: (scope: RewindScope) => void
}) {
  const [scope, setScope] = React.useState<RewindScope>(defaultScope)
  /* A fresh pick per opening: the dialog is reused across turns, and the
     scope chosen for the last one is not a default for this one. Clamped to
     what this turn actually offers — a files-only turn must not reopen on a
     conversation scope that no longer exists. */
  React.useEffect(() => {
    if (open) {
      setScope(
        defaultScope === "conversation" && !canRewindConversation
          ? "files"
          : defaultScope === "files" && !hasFiles
            ? canRewindConversation
              ? "both"
              : "files"
            : defaultScope
      )
    }
  }, [open, defaultScope, canRewindConversation, hasFiles])

  const confirmDisabled =
    busy || (scope !== "conversation" && !hasFiles) || (scope !== "files" && !canRewindConversation)

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Rewind to before {turnLabel}?</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogDescription>
          {turnPreview.trim() ? (
            <>
              <span className="text-muted-foreground">From </span>
              <span dir="auto" className="line-clamp-2 font-medium text-foreground">
                “{turnPreview.trim().slice(0, 160)}”
              </span>{" "}
              <span className="text-muted-foreground">onward, everything is discarded.</span>
            </>
          ) : (
            <>Everything from {turnLabel} onward is discarded.</>
          )}
        </ResponsiveDialogDescription>
        <RadioGroup
          value={scope}
          onValueChange={(v) => setScope(v as RewindScope)}
          className="gap-3 px-1 py-1"
        >
          {canRewindConversation && (
            <label className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem value="both" id="rewind-both" className="mt-0.5" />
              <span>
                <Label htmlFor="rewind-both" className="cursor-pointer">
                  Conversation + files
                </Label>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Fork the conversation back and restore the worktree to how it was when the turn
                  began.
                </span>
              </span>
            </label>
          )}
          {canRewindConversation && (
            <label className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem value="conversation" id="rewind-conversation" className="mt-0.5" />
              <span>
                <Label htmlFor="rewind-conversation" className="cursor-pointer">
                  Conversation only
                </Label>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Keep the files as they are — only the conversation goes back.
                </span>
              </span>
            </label>
          )}
          <label
            className={
              hasFiles
                ? "flex cursor-pointer items-start gap-3"
                : "flex items-start gap-3 opacity-60"
            }
          >
            <RadioGroupItem value="files" id="rewind-files" className="mt-0.5" disabled={!hasFiles} />
            <span>
              <Label htmlFor="rewind-files" className={hasFiles ? "cursor-pointer" : undefined}>
                Files only
              </Label>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {hasFiles
                  ? "Restore the worktree to how it was when the turn began — the transcript stays whole."
                  : "This turn has no file snapshot to restore."}
              </span>
            </span>
          </label>
        </RadioGroup>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(scope)}
            disabled={confirmDisabled}
          >
            {busy ? <Spinner /> : <History className="size-4" />}
            Rewind
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

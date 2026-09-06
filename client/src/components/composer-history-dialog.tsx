/* ── The prompt history, as something to browse ──
   Up walks the same list one step at a time (`usePromptHistory` in
   composer.tsx); this is the other half of the same feature, for the line you
   remember writing but not when. Global across every thread, because that is
   what the history is — see `lib/composer-history.ts`.

   It lives beside the composer rather than in ⌘K for the reason the "+" menu
   exists at all: picking an old prompt is *adding to the message*, and the
   thing it adds to is the box under it. A palette page would have had to hand
   the text across a surface boundary that nothing else in this app crosses
   (`subscribeDraft` was built for it and has no callers); here it is a
   `setText` on the composer that owns the state.

   Filtering is a plain substring match on this device, not a server query: the
   whole list is already in hand (the cache the composer reads), it is capped at
   500 rows server-side, and a debounce plus a spinner for a match against text
   we are holding would be slower and less certain than the match itself. */
import * as React from "react"
import { History, Search, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import type { ComposerHistoryEntry } from "@/lib/composer-history"
import { useClearComposerHistory, useComposerHistory } from "@/lib/queries"
import { reportError } from "@/lib/errors"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

/** How many rows are drawn at once. The list is capped at 500 server-side, but
    a dialog that renders all of them is a scroll nobody reads to the end of —
    and the query is how you reach the rest. */
const SHOWN = 60

export function ComposerHistoryDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Puts the line in the box. The composer decides whether that replaces what
      is there or is appended — this only says which line was chosen. */
  onPick: (text: string) => void
}) {
  const { items, isPending } = useComposerHistory()
  const forget = useClearComposerHistory()
  const confirm = useConfirm()
  const [query, setQuery] = React.useState("")

  // A dialog that reopens holding last week's query is one you have to clear
  // before you can use it.
  React.useEffect(() => {
    if (open) setQuery("")
  }, [open])

  const needle = query.trim().toLowerCase()
  const matches = React.useMemo(
    () => (needle ? items.filter((i) => i.text.toLowerCase().includes(needle)) : items),
    [items, needle]
  )
  const shown = matches.slice(0, SHOWN)

  const pick = (entry: ComposerHistoryEntry) => {
    onPick(entry.text)
    onOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Prompt history</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Everything you have sent, newest first — from every thread.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your prompts…"
            className="ps-9"
          />
        </div>

        <div className="-mx-1 max-h-[55vh] min-h-24 overflow-y-auto px-1">
          {shown.map((entry) => (
            <div
              key={entry.id}
              className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted"
            >
              {/* The row is the button: the whole line picks it, so there is no
                  hunting for a target on a phone. */}
              <button
                type="button"
                onClick={() => pick(entry)}
                className="min-w-0 flex-1 text-start"
              >
                {/* Three lines at most. A pasted essay is one row like any
                    other — the search is how you tell two of them apart. */}
                <span className="line-clamp-3 whitespace-pre-wrap text-sm">{entry.text}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{shortAge(entry.createdAt)}</span>
                  {entry.threadTitle && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{entry.threadTitle}</span>
                    </>
                  )}
                </span>
              </button>
              {/* Forgetting one line. Visible on touch, where there is no
                  hover to reveal it. */}
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground opacity-100 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                title="Forget this prompt"
                onClick={() =>
                  forget.mutate(entry.id, {
                    onError: (err) => reportError(err, "Couldn't forget that prompt"),
                  })
                }
              >
                <X />
              </Button>
            </div>
          ))}

          {/* Three states a bare empty list would draw identically, and one of
              them is "still reading" — which must never look like "nothing". */}
          {shown.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {isPending
                ? "Reading your history…"
                : needle
                  ? "No prompt matches that."
                  : "Nothing sent yet — what you send from any thread shows up here."}
            </p>
          )}
        </div>

        {/* Said only when the cap is actually hiding something, so the number
            is never a decoration. */}
        {matches.length > shown.length && (
          <p className="text-center text-[11px] text-muted-foreground">
            Showing {shown.length} of {matches.length} — search to narrow it.
          </p>
        )}

        {items.length > 0 && (
          <div className="flex justify-end border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              className={cn("text-muted-foreground hover:text-destructive")}
              /* Asked for, because it cannot be undone and the thing it throws
                 away is every sentence the user has written. Forgetting ONE
                 line does not ask: it is one row, and it is aimed. */
              onClick={() => {
                void confirm({
                  title: "Clear prompt history?",
                  description: `This forgets all ${items.length} prompts on every device. It cannot be undone.`,
                  confirmLabel: "Clear history",
                  destructive: true,
                }).then((ok) => {
                  if (!ok) return
                  forget.mutate(undefined, {
                    onError: (err) => reportError(err, "Couldn't clear the history"),
                  })
                })
              }}
            >
              <Trash2 />
              Clear history
            </Button>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

export { History as ComposerHistoryIcon }

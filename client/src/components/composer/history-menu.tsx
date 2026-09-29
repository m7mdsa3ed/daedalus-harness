/* ── The prompt history, as something to browse ──
   Up walks the same list one step at a time (`usePromptHistory`); this is the
   other half, for the line you remember writing but not when. A submenu of the
   "+" rather than a dialog: picking an old prompt is *adding to the message*,
   and a dialog in front of the box you are filling hides the box.

   Filtering is a plain substring match on this device: the whole list is
   already in hand (the cache the composer reads) and capped at 500 rows
   server-side. */
import * as React from "react"
import { History, Trash2 } from "lucide-react"

import { CompleterList, CompleterRow } from "@/components/composer/completer"
import type { ComposerHistoryEntry } from "@/lib/composer-history"

import { useConfirm } from "@/components/confirm-dialog"
import { MenuSearchInput } from "@/components/config-menu"
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { useClearComposerHistory, useComposerHistory } from "@/lib/queries"
import { reportError } from "@/lib/errors"
import { shortAge } from "@/lib/time"

/** Rows drawn at once; the search is how you reach the rest. */
const SHOWN = 50

export function ComposerHistorySubmenu({
  shortcut,
  onPick,
}: {
  shortcut?: string
  /** Puts the line in the box — the composer decides replace vs append. */
  onPick: (text: string) => void
}) {
  const { items, isPending } = useComposerHistory()
  const forget = useClearComposerHistory()
  const confirm = useConfirm()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The box is about *this* opening, never the last one.
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const needle = query.trim().toLowerCase()
  const matches = React.useMemo(
    () => (needle ? items.filter((i) => i.text.toLowerCase().includes(needle)) : items),
    [items, needle]
  )
  const shown = matches.slice(0, SHOWN)

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <History />
        Earlier prompt
        {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-h-96 w-[min(28rem,calc(100vw-2rem))] no-scrollbar">
          <MenuSearchInput label="prompts" value={query} onChange={setQuery} />
          {shown.map((entry) => (
            <DropdownMenuItem
              key={entry.id}
              onClick={() => onPick(entry.text)}
              className="flex-col items-start gap-0.5"
            >
              {/* Two lines at most — the search tells two long ones apart. */}
              <span className="line-clamp-2 w-full whitespace-pre-wrap text-sm">{entry.text}</span>
              <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="shrink-0">{shortAge(entry.createdAt)}</span>
                {entry.threadTitle && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{entry.threadTitle}</span>
                  </>
                )}
              </span>
            </DropdownMenuItem>
          ))}
          {/* "Still reading" must never look like "nothing". */}
          {shown.length === 0 && (
            <DropdownMenuItem disabled className="justify-center text-xs">
              {isPending ? "Reading your history…" : needle ? "No prompt matches that." : "Nothing sent yet."}
            </DropdownMenuItem>
          )}
          {matches.length > shown.length && (
            <p className="px-2 py-1 text-center text-[11px] text-muted-foreground">
              Showing {shown.length} of {matches.length} — search to narrow it.
            </p>
          )}
          {items.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {/* Asked for: it cannot be undone, and it is every sentence. */}
              <DropdownMenuItem
                variant="destructive"
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
                Clear history…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/** The Up walk, drawn: the strip shows where in the history the box is, the
    way the `@` completer shows the files a query matches. Oldest at the top,
    so the highlight moves the way the arrow points. */
export function PromptHistoryWalk({
  rows,
  selected,
  onSelect,
}: {
  rows: ComposerHistoryEntry[]
  selected: number
  onSelect: (index: number) => void
}) {
  return (
    <CompleterList selected={selected} count={rows.length} hint="Earlier prompts — esc puts back what you typed">
      {rows.map((entry, i) => (
        <CompleterRow
          key={entry.id}
          icon={History}
          label={entry.text.split("\n", 1)[0]}
          description={entry.threadTitle ?? undefined}
          aside={shortAge(entry.createdAt)}
          selected={i === selected}
          onPick={() => onSelect(i)}
          onHover={() => {}}
        />
      ))}
    </CompleterList>
  )
}

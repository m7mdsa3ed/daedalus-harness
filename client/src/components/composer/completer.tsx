import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Kbd } from "@/components/ui/kbd"
import { useCoarsePointer } from "@/hooks/use-device"
import { ComposerStripItem, SHELF_PAD } from "../composer-strip"

/* The one list and the one row every composer completer draws — `/`
   (`slash-commands.tsx`), `@` (`file-mentions.tsx`) and `!`
   (`project-commands.tsx`).

   The three menus are the same object with different contents: a strip item
   holding a capped scroller, a highlighted row picked with the keyboard or
   with **mousedown** (click fires after the textarea has lost focus, so it is
   the only event that can pick without moving the caret), and a selection that
   must scroll itself into view. Written three times they drifted — three
   paddings, three truncation rules, three answers to what a row may say.

   **A row is three columns: the mark, the body, the facts.** Everything that
   is *about* the row rather than part of it — a size, a kind, a warning —
   stands in a column of its own at the end, so the list has one line of marks
   down its right edge and the body never fights them for width. The body's
   second line is drawn only when there is something to say, so a list of bare
   names is a list of single-height rows.

   **What is only true of the whole list is said once, not per row**: a heading
   over a run (`CompleterSection`, the `!` menu's two sources) and the foot's
   `hint` (the directory an `@` query is in) replaced a badge and a second line
   that every row repeated.

   The key hint is the device's question, not the panel's (`useCoarsePointer`):
   a soft keyboard has no ↑↓, and the row of caps would be three dead glyphs
   under a menu you drive by tapping. */

/** What a row says, whichever menu it came from. */
export interface CompleterRowProps {
  icon: LucideIcon
  /** A picture drawn in the icon's place — a project's logo. */
  mark?: React.ReactNode
  /** Dimmed and said *before* the label, on the same line: the directory a file
      is in. It is the part that truncates first — what the eye needs is the end
      of the row, not the start of the path. */
  prefix?: string
  /** The identity of the row — a path, a command, a shell line. Monospace. */
  label: string
  /** Said beside the label because it is part of what you are about to type —
      an argument hint. A *fact about* the row goes in `aside`. */
  meta?: string
  /** A fact about the row, pinned to its end: a size, a count. Never competes
      with the label for width. */
  aside?: string
  /** The second line. Prose, and the part that may be long. */
  description?: string
  /** What *kind* of row this is, where the list mixes kinds and no section
      header already says so. */
  badge?: string
  /** A mark at the row's end — a warning, a state. */
  trailing?: React.ReactNode
  selected: boolean
  onPick: () => void
  onHover: () => void
}

/* Three columns: the mark, the body, and everything that is *about* the row.
   It was one flex row with the badge pushed out by `ml-auto` from inside the
   body, so where a row's badge sat depended on how long its name was — a
   column of badges that stepped in and out as the list filtered. The end
   cluster is its own column now, so every mark in the list stands on one line
   and the body gets all the width that is left. */
export function CompleterRow({
  icon: Icon,
  mark,
  prefix,
  label,
  meta,
  aside,
  description,
  badge,
  trailing,
  selected,
  onPick,
  onHover,
}: CompleterRowProps) {
  return (
    <button
      type="button"
      data-selected={selected || undefined}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      onMouseMove={onHover}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-2 text-left text-sm sm:py-1.5",
        selected && "bg-muted text-foreground"
      )}
    >
      {mark ?? (
        <Icon
          className={cn(
            "size-4 shrink-0",
            selected ? "text-foreground" : "text-muted-foreground"
          )}
        />
      )}
      <span className="col-start-2 flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-1 font-mono text-sm">
          {prefix && (
            <span className="min-w-0 shrink truncate text-muted-foreground">{prefix}</span>
          )}
          <span className="min-w-0 truncate">{label}</span>
          {meta && (
            <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </span>
        {description && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {(aside || badge || trailing) && (
        <span
          className={cn(
            "col-start-3 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          )}
        >
          {aside && <span className="font-mono tabular-nums">{aside}</span>}
          {badge && (
            <Badge variant="secondary">{badge}</Badge>
          )}
          {trailing}
        </span>
      )}
    </button>
  )
}

/** A heading over a run of rows, where a list mixes kinds — said once for the
    group instead of as a badge on every row of it. */
export function CompleterSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
      {children}
    </div>
  )
}

/**
 * The scroller the rows live in: capped at roughly five rows so a long catalog
 * cannot push the composer off the bottom of the screen (the rule the plan list
 * follows), scrolling the selected row into view, and closed by a line naming
 * the three keys that drive it.
 */
export function CompleterList({
  selected,
  count,
  hint,
  children,
}: {
  /** The two things a selection change is watched by — keep the row visible. */
  selected: number
  count: number
  /** What this list is of, said at the foot's start — the directory an `@`
      query is searching, the scope a list came from. The keys keep the end. */
  hint?: string
  children: React.ReactNode
}) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const coarse = useCoarsePointer()
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [selected, count])

  return (
    <ComposerStripItem>
      <div ref={listRef} className="max-h-52 overflow-y-auto p-1 overscroll-contain">
        {children}
      </div>
      {/* `SHELF_PAD` here and the rows' own `p-1` + `px-2` land at the same
          12px, so the hint and the keys that drive the list line up with the
          rows above them rather than sitting 2px inboard. */}
      {(hint || !coarse) && (
        <div className={cn(SHELF_PAD, "flex items-center gap-3 border-t py-1 text-xs text-muted-foreground")}>
          {hint && <span className="mr-auto min-w-0 truncate font-mono">{hint}</span>}
          {coarse ? null : (
            <>
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd>
            dismiss
          </span>
            </>
          )}
        </div>
      )}
    </ComposerStripItem>
  )
}

/** The one-line "nothing yet" / hint row the menus draw instead of a list. */
export function CompleterNote({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <ComposerStripItem className={cn(SHELF_PAD, "flex items-center gap-2 py-1.5 text-xs text-muted-foreground")}>
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </ComposerStripItem>
  )
}

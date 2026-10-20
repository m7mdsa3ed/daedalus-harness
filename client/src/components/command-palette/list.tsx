/* ── Drawing the rows `rank.ts` ordered ──
   One section per heading, one `Row` per item — the menu still owns selection
   and ↑/↓; it just does not own the filter any more.

   Every row is the same four columns, whatever page it is on:

     ┌────┬──────────────────────────────┬───────────────┬──────┐
     │tile│ title  [badges]              │ meta · meta   │ end  │
     │    │ subtitle                     │               │      │
     └────┴──────────────────────────────┴───────────────┴──────┘

   The tile is a fixed box, so a glyph, a project mark and an agent's logo all
   sit on one vertical line; the body is the only column that grows; the meta
   column truncates as one unit from the right; and the end slot holds a chord
   or a tick, never both. A row declares what goes in each slot and nothing
   about where — which is the whole reason the rows on nine pages line up.

   ── Why a page publishes instead of rendering ──
   `CommandMenu` (`ui/command-menu.tsx`) is items-driven: the root is handed the
   flat list, and *it* derives the sections, the flat index every row is keyed
   by, the keyboard's idea of "next row" and the hover fill's idea of which row
   it is over. A row drawn inside the list that the root's array does not name
   is a row the arrows skip and the fill cannot reach — which is why the notes
   the search page interleaves are rows here (`PaletteItem.note`) rather than
   the bare `<div>`s they used to be.

   But a page is a *component*: it has a query, a debounce, a store read. So it
   renders for its hooks and draws nothing, handing its ranked groups up to the
   shell through `PaletteRowsProvider`. The shell puts them on the root, and the
   root hands each one back down to `Row` through `renderItem`.

   The loop that shape invites — publish, shell re-renders, page re-renders,
   publishes again — is closed at the other end, in `index.tsx`: the page is
   `React.memo`'d and the palette context value is memoized on its real deps,
   so a publish does not re-render the page that caused it. Both halves are
   load-bearing; see the note there. */
import * as React from "react"
import { CheckIcon } from "lucide-react"

import { CommandMenuItem, type CommandMenuItemData } from "@/components/ui/command-menu"
import { Shortcut } from "@/components/shortcut"
import { Badge as UiBadge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import {
  type BadgeTone,
  type PaletteBadge,
  type PaletteItem,
  type PaletteMeta,
  rankItems,
} from "./rank"

export type { PaletteBadge, PaletteItem, PaletteMeta }
export { rankItems }

/** A heading and the rows under it, in the order they are to be drawn. */
export interface PaletteGroup {
  name: string
  items: PaletteItem[]
}

type Publish = (groups: PaletteGroup[]) => void

const PublishContext = React.createContext<Publish | null>(null)

export const PaletteRowsProvider = PublishContext.Provider

/** Hand this page's rows to the shell. Layout-effect rather than effect so the
    rows land in the same frame the page rendered them — an ordinary effect
    paints one frame of the previous page's list. */
function usePublish(groups: PaletteGroup[]) {
  const publish = React.useContext(PublishContext)
  React.useLayoutEffect(() => {
    publish?.(groups)
  }, [publish, groups])
}

/** A page that is a list of *things you can do*: declare the rows, and this
    scores, orders and groups them. Draws nothing — see the header. */
export function ItemList({
  items,
  query,
  recents,
}: {
  items: PaletteItem[]
  query: string
  /** Command ids this device used, newest first. Only the root page has a
      stable command vocabulary to remember, so only it passes them. */
  recents?: string[]
}) {
  const groups = React.useMemo(() => rankItems(items, query, recents), [items, query, recents])
  usePublish(groups)
  return null
}

/** A page whose order is somebody else's — the server's ranking, or the clock.
    Same publishing, no scoring: the groups are drawn exactly as given. */
export function OrderedList({ groups }: { groups: PaletteGroup[] }) {
  usePublish(groups)
  return null
}

/** The shell's half of the contract: flatten the published groups into the flat
    array the menu root wants. `group` is what it re-derives the sections from,
    and it keeps each heading's first-appearance order — which is the order
    `rankItems` already decided, so the two never disagree.

    A note is `disabled` here and nowhere else: that one flag is what makes the
    keyboard walk past it while the row still holds its place in the list.

    **One unheaded group per page.** The menu keys its sections by heading
    (`sectionRows`), so a second group with an empty name does not become a
    second unheaded section — its rows are appended to the first one's, which
    is to say they move to where the first one stands. A page that wants a
    leading note and a trailing one puts both in the same group. */
export function toMenuItems(groups: PaletteGroup[]): CommandMenuItemData[] {
  return groups.flatMap((group) =>
    group.items.map(
      (item): CommandMenuItemData => ({
        value: item.id,
        label: item.title,
        group: group.name || undefined,
        disabled: item.note,
        onSelect: item.onSelect,
      })
    )
  )
}

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "",
  primary: "bg-primary/10 text-primary",
  warn: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
  success: "bg-success/10 text-success",
}

export function Row({ item }: { item: PaletteItem }) {
  if (item.note) return <Note item={item} />

  const hasEnd = !!item.chord || item.checked !== undefined
  return (
    <CommandMenuItem
      value={item.id}
      className={cn(
        /* The menu's own row is one fixed-height line (`sizeClasses.control`).
           These are two — a title and a subtitle — so the height is given back
           to the content and only the floor is kept, which is what lines a
           one-line row up with a two-line one on the same page. The inset is
           equal all round (6px) so the tile's rounded-md (8) sits concentric
           in the row's rounded-xl (14). */
        "group/row h-auto min-h-10 items-center gap-3 p-1.5",
        item.muted && "opacity-60 aria-selected:opacity-100"
      )}
    >
      <Tile>{item.icon}</Tile>

      <span className="flex min-w-0 flex-1 flex-col justify-center gap-px">
        <span className="flex min-w-0 items-center gap-2">
          {item.fresh && (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />
          )}
          <span className={cn("truncate", item.running && "harness-shimmer text-primary")}>
            {item.title}
          </span>
          {item.badges?.map((badge, index) => (
            <Badge key={index} badge={badge} />
          ))}
        </span>
        {item.subtitle != null && item.subtitle !== "" && (
          <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
        )}
      </span>

      {item.meta && item.meta.length > 0 && <Meta parts={item.meta} />}

      {hasEnd && (
        <span className="flex shrink-0 items-center justify-end">
          {item.chord ? (
            <Shortcut
              chord={item.chord}
              keyClassName="group-aria-selected/row:bg-background"
            />
          ) : (
            <CheckIcon
              className={cn(
                "size-4 text-primary transition-opacity",
                item.checked ? "opacity-100" : "opacity-0"
              )}
            />
          )}
        </span>
      )}
    </CommandMenuItem>
  )
}

/** A line about the list rather than an entry in it. Still a `CommandMenuItem`,
    because the root's flat array is what the keyboard and the hover fill count
    in — it is simply the disabled one, which both of them step over. */
function Note({ item }: { item: PaletteItem }) {
  return (
    <CommandMenuItem
      value={item.id}
      className={cn(
        // With a mark: the row's own inset and a bare tile-sized slot, so the
        // words start on the titles' column. Without one: a menu note's px-3 py-2.
        item.icon ? "h-auto min-h-0 cursor-default gap-3 p-1.5 text-sm" : "h-auto min-h-0 cursor-default px-3 py-2 text-sm",
        item.noteTone === "warn" ? "text-warning" : "text-muted-foreground",
        // `disabled` fades a row that could have been picked; a note was never
        // going to be, so the fade is only noise over text meant to be read.
        "!opacity-100"
      )}
    >
      {item.icon && (
        <span className="flex size-7 shrink-0 items-center justify-center [&_svg:not([class*='size-'])]:size-4">
          {item.icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{item.title}</span>
    </CommandMenuItem>
  )
}

/** The leading box every glyph sits in. A raster mark (a project's logo, an
    agent's) fills it; a stroke icon is centred at the row size. */
function Tile({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        "transition-colors group-aria-selected/row:bg-background group-aria-selected/row:text-foreground",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "[&_img]:size-5"
      )}
    >
      {children}
    </span>
  )
}

function Badge({ badge }: { badge: PaletteBadge }) {
  return (
    <UiBadge variant="secondary" className={cn("shrink-0", badge.className ?? BADGE_TONE[badge.tone ?? "neutral"])}>
      {badge.label}
    </UiBadge>
  )
}

/** The right column. One flex row that shrinks before the body does and cuts
    from its own right edge, so a long path loses its tail while the age beside
    it — the part that is short and always wanted — stays. */
function Meta({ parts }: { parts: PaletteMeta[] }) {
  return (
    <span className="flex max-w-[45%] min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="shrink-0 opacity-50">·</span>}
          <span
            className={cn(
              "flex min-w-0 items-center gap-1",
              part.dim ? "shrink-0 opacity-70" : "shrink",
              part.mono && "font-mono",
              (part.dim || /\d/.test(part.label)) && "tabular-nums"
            )}
          >
            {part.icon && (
              <span className="flex shrink-0 items-center [&_img]:size-3.5 [&_svg:not([class*='size-'])]:size-3.5">
                {part.icon}
              </span>
            )}
            <span className="truncate">{part.label}</span>
          </span>
        </React.Fragment>
      ))}
    </span>
  )
}

/* ── Drawing the rows `rank.ts` ordered ──
   One `CommandGroup` per heading, one `Row` per item — cmdk still owns
   selection and ↑/↓; it just does not own the filter any more.

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

   The item is cmdk's primitive rather than `ui/command`'s `CommandItem`: that
   one draws an always-present, usually invisible tick at the end of every row,
   which is exactly the 16px of drift the trailing content on every page was
   fighting with `ml-auto`. */
import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { CheckIcon } from "lucide-react"

import { CommandGroup } from "@/components/ui/command"
import { Shortcut } from "@/components/shortcut"
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
  return (
    <>
      {groups.map((group) => (
        <Group key={group.name} heading={group.name}>
          {group.items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </Group>
      ))}
    </>
  )
}

/** A heading in the palette's own voice — small caps, tracked, and with the
    same horizontal inset as the tile below it so the label and the glyphs
    share a left edge. */
export function Group({ heading, children }: { heading?: string; children: React.ReactNode }) {
  return (
    <CommandGroup
      heading={heading || undefined}
      className={cn(
        "px-2 py-1.5",
        "**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:pb-1",
        "**:[[cmdk-group-heading]]:text-[10.5px] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:text-muted-foreground/80"
      )}
    >
      {children}
    </CommandGroup>
  )
}

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "bg-destructive/10 text-destructive",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
}

export function Row({ item }: { item: PaletteItem }) {
  const hasEnd = !!item.chord || item.checked !== undefined
  return (
    <CommandPrimitive.Item
      value={item.id}
      data-slot="palette-row"
      data-checked={item.checked}
      onSelect={item.onSelect}
      className={cn(
        "group/row relative flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-hidden select-none",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "data-selected:bg-accent data-selected:text-accent-foreground",
        item.muted && "opacity-60 data-selected:opacity-100"
      )}
    >
      <Tile>{item.icon}</Tile>

      <span className="flex min-w-0 flex-1 flex-col justify-center gap-px">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.fresh && (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />
          )}
          <span className={cn("truncate leading-5", item.running && "harness-shimmer text-primary")}>
            {item.title}
          </span>
          {item.badges?.map((badge, index) => (
            <Badge key={index} badge={badge} />
          ))}
        </span>
        {item.subtitle != null && item.subtitle !== "" && (
          <span className="truncate text-[11px] leading-4 text-muted-foreground">{item.subtitle}</span>
        )}
      </span>

      {item.meta && item.meta.length > 0 && <Meta parts={item.meta} />}

      {hasEnd && (
        <span className="flex shrink-0 items-center justify-end">
          {item.chord ? (
            <Shortcut
              chord={item.chord}
              keyClassName="h-5 min-w-5 bg-background/60 text-[11px] text-muted-foreground group-data-selected/row:bg-background group-data-selected/row:text-foreground"
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
    </CommandPrimitive.Item>
  )
}

/** The leading box every glyph sits in. A raster mark (a project's logo, an
    agent's) fills it; a stroke icon is centred at the row size. */
function Tile({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground ring-1 ring-border/50 ring-inset",
        "transition-colors group-data-selected/row:bg-background group-data-selected/row:text-foreground",
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
    <span
      className={cn(
        "shrink-0 rounded-pill px-1.5 py-px text-[10px] font-medium leading-4",
        badge.className ?? BADGE_TONE[badge.tone ?? "neutral"]
      )}
    >
      {badge.label}
    </span>
  )
}

/** The right column. One flex row that shrinks before the body does and cuts
    from its own right edge, so a long path loses its tail while the age beside
    it — the part that is short and always wanted — stays. */
function Meta({ parts }: { parts: PaletteMeta[] }) {
  return (
    <span className="flex max-w-[45%] min-w-0 shrink items-center gap-1.5 text-[11px] leading-4 text-muted-foreground group-data-selected/row:text-accent-foreground/80">
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

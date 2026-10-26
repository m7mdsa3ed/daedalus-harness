/* ── Settings layout primitives ──
   The shared visual vocabulary of every settings page: header, group, row,
   field, picker. Pages import from here; nothing here knows which page it is
   on — which is what makes the look one edit in this file rather than twenty.

   ── The style: cards and surfaces ──
   Every group is a **card** - the registry Card's ground and ring - whose
   rows are divided by hairlines - under a heading (`SectionHead`) that always
   sits above it, on every width. See "The kit" below for the four page shapes.
   A settings page is a list of lists, and a card is what says where one list
   stops and the next begins without asking the reader to count blank space.

   It was flat for a while (a caption on a hairline, rows on hairlines) because
   a stack of cards is a stack of borders in a narrow dock panel. What that got
   wrong is that air is not a boundary: at the bottom of a long page a group of
   four rows and a group of nine read as one list of thirteen. The card's gutter
   is the cost, and it is paid where it is cheapest — the inset drops from 16px
   to 12px below `@panel-sm`, so a 320px panel keeps its reading width.

   The **inset is the card's, not the row's**: pages put raw elements into a
   `Group` as often as they put `Row`s, and a padded container gives both the
   same left edge for free. Anything that needs to bleed to the card's edge
   reaches out with `-mx-3 @panel-sm:-mx-4`.

   ── Two questions, two mechanisms (docs/client.md) ──
   Layout is the **panel's**, so everything that reflows is a `@panel-sm:`
   container query and never `sm:`: settings can be half a window wide beside a
   terminal, and a media query would draw the desktop row there. Touch targets
   are the **device's**, so controls grow to 44px on `pointer-coarse:` rather
   than asking a width about a finger. */
import * as React from "react"
import { Search, type LucideIcon } from "lucide-react"
import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/busy-button"
import { Field as FieldRoot, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { FilePicker } from "@/components/files/file-picker"
import { useFileActions } from "@/lib/files"
import { logoFromFile } from "@/lib/logo-file"
import { reportError } from "@/lib/errors"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { SurfaceHeader } from "@/components/page-primitives"
import type { InlineError } from "@/lib/errors"
import { KEYBOARD_RISE } from "@/lib/keyboard-inset"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-device"
import { type PageMeta } from "./sections"
import { AiFormBuilder } from "./ai-form-builder"


/** A settings section's header: the section's mark, title and description,
    with room for one action and a line of facts. It is `SurfaceHeader` — the
    one header every page draws — fed from the section's `PageMeta`. */
export function PageHeader({
  meta,
  action,
  facts,
  flush = false,
}: {
  /** `sectionMeta(...)` carries the section's icon; a page that passes a bare
      `PageMeta` simply gets no mark. */
  meta: PageMeta & { icon?: LucideIcon }
  action?: React.ReactNode
  /** Small facts and states under the description. */
  facts?: React.ReactNode
  /** Kept for old callers; the rule drops by itself when a track follows. */
  flush?: boolean
}) {
  return (
    <SurfaceHeader
      icon={meta.icon}
      title={meta.title}
      description={meta.description}
      meta={facts}
      actions={action}
      flush={flush}
    />
  )
}

/** A count beside a label: a section's rows, a tab's items. One chip, so a
    number reads the same wherever the kit draws one. */
export function Count({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("tabular-nums", className)}>
      {children}
    </Badge>
  )
}

/** A control in a `Row`'s slot (a select, an input): the row's width on a
    narrow panel, a fixed column from `@panel-sm`. */
export const ROW_CONTROL = "w-full min-w-0 @panel-sm:w-56"

/** Two fields side by side where the panel has room. */
export const FIELD_GRID = "grid gap-4 @panel-sm:grid-cols-2"

/** The heading every block of a settings page opens with: a title, an optional
    hint, and an optional action at the end (a "New" button, a Reset). One
    shape for `Group`, `FormSection`, and any block a page draws that is not
    a card of rows - so every block on every page starts the same way and the
    eye learns where to look. The hint sits *outside* the card because it is
    about the card rather than a row in it. */
export function SectionHead({
  label,
  hint,
  action,
  count,
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
  /** How many rows the block holds, as a `Count` after the label. */
  count?: number
}) {
  if (!label && !hint && !action) return null
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
      <div className="min-w-0 flex-1 basis-56">
        {label && (
          <h2 className="flex items-center gap-2 font-heading text-base font-medium">
            {label}
            {count !== undefined && <Count>{count}</Count>}
          </h2>
        )}
        {hint && (
          <p className="mt-1 max-w-[68ch] text-sm text-pretty text-muted-foreground">{hint}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/** An anchored block lands clear of the app header. */
const SCROLL_MT = "scroll-mt-[calc(var(--app-header-h)+1rem)]"

/** The page's vertical rhythm, in one place: every block is `Section`, and
    every `Section` is 32px from the next. */
export function Section({
  label,
  hint,
  action,
  count,
  id,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
  count?: number
  /** An anchor target (a `FormShell` bar, a link); clears the app header. */
  id?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} data-kit-block className={cn("mt-8 first:mt-0", id && SCROLL_MT)}>
      <SectionHead label={label} hint={hint} action={action} count={count} />
      {children}
    </section>
  )
}

/** The card of a `Group`/`FormSection`. A container, so a tile grid inside
    answers to the card's width, and `overflow-hidden` so a full-bleed child
    (a table, a scroller that reaches out with `-mx-3`) is clipped to the
    card's radius instead of squaring off its corners. */
const CARD = "@container min-w-0 overflow-hidden rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/10"

/** The first of four page shapes (see "The kit" below): a heading over one
    card whose rows are divided by hairlines. */
export function Group({
  label,
  hint,
  action,
  count,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
  count?: number
  children: React.ReactNode
}) {
  return (
    <Section label={label} hint={hint} action={action} count={count}>
      <div className={cn(CARD, "divide-y px-3 @panel-sm:px-4")}>{children}</div>
    </Section>
  )
}

/** One line in a Group: label/description on the left, control on the right.

    The text block has a *basis*, not `flex-1`: with a zero basis it could shrink
    without limit, so a row whose actions are three text buttons — the servers
    list — squeezed the name to a truncated word and the URL to a two-character
    column rather than ever wrapping. Given a real minimum the wrap happens on
    its own, per row and per viewport: a switch or a pair of icon buttons still
    sits inline, a wide cluster drops to a second line and stays right-aligned.
    `@panel-sm:flex-nowrap` keeps every row on one line once there is room for one. */
export function Row({
  icon: Icon,
  handle,
  title,
  subtitle,
  children,
}: {
  /** A drag grip, drawn before the icon — a list whose order is the user's
      (projects). Absent everywhere else, which is most rows. */
  handle?: React.ReactNode
  /** A Lucide component, or an already-rendered element (a profile's logo). */
  icon?: LucideIcon | React.ReactElement
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="group/row flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-3 py-3 @panel-sm:flex-nowrap">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {handle}
        {Icon && (
          <div className="mt-0.5 shrink-0">
            {React.isValidElement(Icon) ? Icon : <Icon className="size-4 text-muted-foreground" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle && (
            <div className="mt-0.5 text-sm break-words text-muted-foreground">{subtitle}</div>
          )}
        </div>
      </div>
      {/* Wrapped below the text on a narrow panel, the cluster keeps its right
          edge rather than sliding under the label: a column of controls that
          all end on one line is scannable, and a Switch on the left of a wide
          empty row reads as a bullet. */}
      {children && (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
      )}
    </div>
  )
}

/** A box *inside* a card — a nested list, an inline add/edit form, one item of
    a reorderable set. Now that a `Group`/`FormSection` is itself a card, these
    used to draw a second `rounded-lg border` on the card's own ground, which
    is two identical frames one inside the other and reads as a rendering bug.
    A recessed ground with a lighter hairline says "inside" instead. One token
    so every nested box in every page agrees. */
export const INSET = "rounded-xl border bg-muted/50"

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: React.ReactNode
  /** Ties the label to its control's id, where the control has one. */
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <FieldRoot className="[&_[data-slot=input]]:pointer-coarse:h-11 [&_[data-slot=select-trigger]]:pointer-coarse:h-11">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription className="max-w-[68ch]">{hint}</FieldDescription>}
    </FieldRoot>
  )
}

/** Labeled group of Fields inside a form - `Group`'s heading and card, with
    the fields stacked inside it rather than divided into rows, so a form reads
    as the same object a list does. `id` is the target of a `SectionRail`. */
export function FormSection({
  label,
  hint,
  action,
  count,
  id,
  children,
}: {
  label: string
  hint?: React.ReactNode
  action?: React.ReactNode
  count?: number
  id?: string
  children: React.ReactNode
}) {
  return (
    <div id={id} data-kit-block className={cn("mt-8 first:mt-0", SCROLL_MT)}>
      <SectionHead label={label} hint={hint} action={action} count={count} />
      <div className={cn(CARD, "space-y-4 p-3 @panel-sm:p-4")}>{children}</div>
    </div>
  )
}

/** A drill-down page's header (a form, a detail, a run): `SurfaceHeader`
    with its way back. `meta`/`actions` are for the read-only detail pages. */
export function FormPageHeader({
  title,
  description,
  onBack,
  meta,
  actions,
  flush = false,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  onBack: () => void
  meta?: React.ReactNode
  actions?: React.ReactNode
  /** Kept for old callers; the rule drops by itself when a track follows. */
  flush?: boolean
}) {
  return (
    <SurfaceHeader
      onBack={onBack}
      title={title}
      description={description}
      meta={meta}
      actions={actions}
      flush={flush}
    />
  )
}

/* ── The kit: one pattern for each question ──
   The settings pages used to answer "how do I switch, choose or open" seven
   different ways (pill tabs, line tabs, an animated tab bar, an iOS segmented
   track, local radio buttons, a vertical rail with a native select under it, a
   dropdown on a phone). One question now has one answer, on every page and at
   every width:

     Go somewhere else        the app sidebar; on a phone, the overview list
                              and the page's "Settings" back link (no dropdown)
     Switch this page's view  TabBar - a track of tabs under the header, scrolled
                              away with the page (never a sticky bar)
     Jump within a long form  FormShell - the same TabBar as anchors, scroll-spied
     Pick a value             Segmented (2-4 short words) | Select (more) |
                              ChoiceTiles (options you must SEE: mode, layout)
     Filter a list            the DataTable's toolbar: search + Segmented
     Open an item             a DataTable row -> its own page (never a sheet or side rail)
     Create / destructive     the header's action / the row's actions
     Say a state              StatusBadge (ok / warn / bad / info / neutral)

   A page is: PageHeader -> [TabBar] -> [StatStrip] -> blocks (SectionHead over
   a card, or a DataTable). There are no vertical rails inside a page: the
   sidebar is the one vertical navigation in the app. Reflow is the *panel's*
   (`@panel-*`) or the block's own container, never a media query. */

export type Tone = "default" | "ok" | "warn" | "bad"
const TONE_TEXT: Record<Tone, string> = {
  default: "text-foreground",
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
}

/** Two to four numbers about the page, under its header. 2-up on a phone,
    one row from `@panel-sm`. Not interactive: a number you can click is a
    filter, and filters are the `Toolbar`'s. */
export function StatStrip({
  stats,
}: {
  /** `loading` skeletons the value rather than zeroing it: a 0 that turns
      into 400 is a statement the page made and then took back. */
  stats: { label: string; value: React.ReactNode; hint?: string; tone?: Tone; loading?: boolean }[]
}) {
  return (
    <dl
      className={cn(
        "mb-8 grid grid-cols-2 gap-3",
        stats.length === 3 ? "@panel-sm:grid-cols-3" : stats.length >= 4 ? "@panel-sm:grid-cols-4" : "@panel-sm:grid-cols-2"
      )}
    >
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0 rounded-2xl bg-card px-4 py-3 text-card-foreground ring-1 ring-foreground/10">
          <dt className="truncate text-sm text-muted-foreground">{stat.label}</dt>
          <dd className={cn("mt-1 truncate text-2xl font-semibold tabular-nums", TONE_TEXT[stat.tone ?? "default"])}>
            {stat.loading ? <Skeleton className="h-8 w-16" /> : stat.value}
          </dd>
          {stat.hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{stat.hint}</p>}
        </div>
      ))}
    </dl>
  )
}

/** Search, a filter and actions for a collection, in one row that wraps.
    The filter is a `Segmented` - the same control a setting's choice is - so
    "All / Connected / Error" and "Light / Dark / System" look like what they
    are: one pick among a few. `search` is controlled by the page (it owns the
    filtering). */
export function Toolbar({
  search,
  onSearch,
  placeholder = "Search...",
  chips,
  chip,
  onChip,
  children,
}: {
  search?: string
  onSearch?: (value: string) => void
  placeholder?: string
  chips?: { id: string; label: string; count?: number }[]
  chip?: string
  onChip?: (id: string) => void
  /** Actions at the row's end (Import, Refresh). */
  children?: React.ReactNode
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 @panel-sm:flex-row @panel-sm:items-center">
      {onSearch && (
        <InputGroup className="h-9 min-w-0 flex-1 pointer-coarse:h-11 @panel-sm:max-w-sm">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={search ?? ""}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder.replace(/\.{3}|\u2026$/, "")}
          />
        </InputGroup>
      )}
      {chips && onChip && (
        <Segmented
          label="Filter"
          value={chip ?? ""}
          onChange={onChip}
          options={chips.map((entry) => ({ value: entry.id, label: entry.label, count: entry.count }))}
        />
      )}
      {children && <div className="flex shrink-0 items-center gap-2 @panel-sm:ml-auto">{children}</div>}
    </div>
  )
}

/** One keyboard model for every tab-like row: arrows move, Home/End jump. */
function useRovingKeys(count: number, current: number, go: (index: number) => void) {
  return (event: React.KeyboardEvent) => {
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? (current + 1) % count
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (current - 1 + count) % count
      : event.key === "Home" ? 0
      : event.key === "End" ? count - 1
      : -1
    if (to < 0) return
    event.preventDefault()
    go(to)
  }
}

export interface TabItem {
  id: string
  label: string
  icon?: LucideIcon
  /** A count or a status dot beside the label. */
  count?: number
  dot?: boolean
  /** The label in a sentence, read on hover: one word is not always enough to
      say which page you are switching to ("Transcript" is how threads read,
      not a transcript you open). */
  hint?: string
}

/** The one in-page switch: a row of underline tabs under the page header, on
    every page and at every width — the registry `Tabs` line variant's look,
    over our own buttons, because `nav` mode is anchors and not a tablist.

    It is **not sticky**. A page's tabs belong to the top of the page and scroll
    away with it: nothing floats over the rows somebody is reading, and the app
    header never has a second bar parked under it. Navigation that follows you
    is the sidebar's job, and it is the only thing that does.

    Overflow scrolls sideways rather than wrapping or turning into a dropdown - a
    phone shows the same tabs the desktop does. `nav` mode is for anchors
    (`FormShell`): same look, `aria-current` instead of `role=tab`, because
    jumping to a section is not switching a panel. A header right above it
    drops its own rule by itself (`data-kit-track`): the track is the break. */
export function TabBar({
  items,
  value,
  onChange,
  label = "Sections",
  nav = false,
  className,
}: {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  label?: string
  nav?: boolean
  className?: string
}) {
  const barRef = React.useRef<HTMLElement | null>(null)
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, items.findIndex((item) => item.id === value))
  const onKeyDown = useRovingKeys(items.length, current, (index) => {
    onChange(items[index].id)
    refs.current[index]?.focus()
  })
  /* The active tab is scrolled into view *within the track*, sideways - it may
     start off-screen on a narrow panel. The page is left where it is:
     `scrollIntoView` was right while this bar was sticky, but now that the bar
     scrolls away with the page it would drag the document back up to it, which
     a scroll-spied `FormShell` would do on every section change. */
  React.useEffect(() => {
    const bar = barRef.current
    const node = refs.current[current]
    if (!bar || !node) return
    const box = bar.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    const start = rect.left - box.left + bar.scrollLeft
    const end = start + rect.width
    if (start < bar.scrollLeft) bar.scrollTo({ left: start - 4 })
    else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: end - bar.clientWidth + 4 })
  }, [current])
  const Root = nav ? "nav" : "div"
  return (
    <Root
      data-kit-track
      ref={(node: HTMLElement | null) => {
        barRef.current = node
      }}
      {...(nav ? { "aria-label": label } : { role: "tablist", "aria-label": label })}
      onKeyDown={nav ? undefined : onKeyDown}
      className={cn(
        "mb-8 flex max-w-full items-center gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {items.map((item, index) => {
        const active = item.id === value
        const Icon = item.icon
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            {...(nav
              ? { "aria-current": active ? ("true" as const) : undefined }
              : { role: "tab", "aria-selected": active, tabIndex: active ? 0 : -1 })}
            onClick={() => onChange(item.id)}
            title={item.hint}
            className={cn(
              "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11",
              "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground after:opacity-0 after:transition-opacity",
              active ? "text-foreground after:opacity-100" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
            {item.label}
            {item.count !== undefined && <Count>{item.count}</Count>}
            {item.dot && <span aria-hidden className="size-1.5 rounded-full bg-destructive" />}
          </button>
        )
      })}
    </Root>
  )
}

/** A form's section bar: `TabBar` as anchors, scroll-spied. The sections are
    `FormSection id=...`; the bar follows the one in view and a click scrolls
    to it. One bar for every width - a vertical rail is a second navigation
    inside a page that already has the sidebar. */
export function FormShell({
  sections,
  children,
}: {
  sections: { id: string; label: string }[]
  children: React.ReactNode
}) {
  const [active, setActive] = React.useState(sections[0]?.id ?? "")
  React.useEffect(() => {
    if (sections.length < 2) return
    const seen = new Map<string, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting)
        const first = sections.find((section) => seen.get(section.id))
        if (first) setActive(first.id)
      },
      { rootMargin: "-20% 0px -65% 0px" }
    )
    for (const section of sections) {
      const node = document.getElementById(section.id)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [sections])
  return (
    /* A track only when it draws one: a single-section form has no bar, and
       the header above it keeps its rule. */
    <div data-kit-track={sections.length > 1 ? "" : undefined}>
      {sections.length > 1 && (
        <TabBar
          nav
          label="Form sections"
          items={sections}
          value={active}
          onChange={(id) => {
            setActive(id)
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }}
        />
      )}
      {children}
    </div>
  )
}

/** The one way to pick among a few short words: Light | Dark | System, All |
    Connected | Error, Export | Import. The registry `Tabs` default look (a muted
    track, the pick on the background) over a `radiogroup` with arrow keys. More than ~5 options, or long labels, is a
    `Select`, not a longer track. Scrolls sideways rather than wrapping. */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; icon?: LucideIcon; count?: number; disabled?: boolean }[]
  disabled?: boolean
  className?: string
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, options.findIndex((option) => option.value === value))
  const onKeyDown = useRovingKeys(options.length, current, (index) => {
    onChange(options[index].value)
    refs.current[index]?.focus()
  })
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 max-w-full items-center overflow-x-auto rounded-4xl bg-muted p-[3px] text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        disabled && "opacity-50",
        className
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7.5 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-4xl border border-transparent px-3 text-sm font-medium whitespace-nowrap outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-10",
              selected
                ? "bg-background text-foreground dark:border-input dark:bg-input/30"
                : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground"
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
            {option.label}
            {option.count !== undefined && <Count>{option.count}</Count>}
          </button>
        )
      })}
    </div>
  )
}

/** Options you have to *see*: a mode, a layout, a tool-step style. Tiles with
    a mark or a live preview, the picked one on the accent ground. `preview`
    replaces the icon when the option can draw itself. */
export function ChoiceTiles<T extends string>({
  label,
  value,
  onChange,
  choices,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  choices: { value: T; label: string; hint?: string; icon?: LucideIcon; preview?: React.ReactNode }[]
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2 py-3 @md:grid-cols-3 @xl:grid-cols-4">
      {choices.map((choice) => {
        const selected = choice.value === value
        const Icon = choice.icon
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice.value)}
            className={cn(
              "flex min-h-20 min-w-0 flex-col items-stretch justify-center gap-1.5 rounded-xl border p-3 text-center text-sm font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
              selected
                ? "border-primary/30 bg-primary/5 text-foreground dark:border-primary/20 dark:bg-primary/10"
                : "text-muted-foreground hover:bg-input/40 hover:text-foreground"
            )}
          >
            {choice.preview ?? (Icon && <Icon className="mx-auto size-5" aria-hidden />)}
            <span className="truncate">{choice.label}</span>
            {choice.hint && <span className="truncate text-xs font-normal text-muted-foreground">{choice.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

export type StatusTone = "ok" | "warn" | "bad" | "info" | "neutral"
const STATUS_CLASS: Record<StatusTone, string> = {
  ok: "bg-success/10 text-success",
  warn: "bg-warning/10 text-warning",
  bad: "",
  info: "bg-primary/10 text-primary",
  neutral: "",
}
const STATUS_DOT: Record<StatusTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  info: "bg-primary",
  neutral: "bg-muted-foreground/60",
}

/** A state, said one way everywhere: connected, needs auth, default, missing.
    A dot, a word, a tone - never a bare colour (the word is the accessible
    half) and never a one-off `bg-emerald-500` in a page. The registry `Badge`
    (`destructive` for bad, `secondary` tinted by `--success`/`--warning`/
    `--primary` for the rest). */
export function StatusBadge({ tone = "neutral", dot = true, children }: { tone?: StatusTone; dot?: boolean; children: React.ReactNode }) {
  return (
    <Badge variant={tone === "bad" ? "destructive" : "secondary"} className={STATUS_CLASS[tone]}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[tone])} />}
      {children}
    </Badge>
  )
}

export type AiFormSchema = Record<string, unknown>

/** Shared vertical rhythm for every route-backed form. Forms opt in with their JSON contract and a state updater. */
export function PageForm({
  className,
  children,
  aiBuilder,
  ...props
}: React.ComponentProps<"form"> & {
  aiBuilder?: {
    title: string
    schema: AiFormSchema
    value: Record<string, unknown>
    onApply: (value: Record<string, unknown>) => void
  }
}) {
  return (
    /* `space-y-6` adds a bottom margin to every child; a kit block already carries
       its own 32px top margin, so the two stacked to ~56px. The kit's blocks
       opt out, everything else (a Notice, the footer) keeps the 24px. */
    <form className={cn("space-y-6 [&>[data-kit-block]]:mb-0", className)} {...props}>
      {aiBuilder && (
        <div className="flex justify-end">
          <AiFormBuilder {...aiBuilder} />
        </div>
      )}
      {children}
    </form>
  )
}

export const lines = (value: string) => value.split("\n").map((l) => l.trim()).filter(Boolean)

/** "NAME=value" / "Name: value" lines -> the {name, value} pairs ACP expects. */
export const pairs = (value: string, sep: string) =>
  lines(value).map((line) => {
    const at = line.indexOf(sep)
    return at === -1
      ? { name: line, value: "" }
      : { name: line.slice(0, at).trim(), value: line.slice(at + sep.length).trim() }
  })

/** Checkbox list for linking library entries (MCP servers, skills) to a project.
    `searchable` adds the filter box and the all/none pair — opt-in, because a
    project's handful of links needs neither and a provider's model list needs
    both. Both act on what the filter leaves visible, and selections outside it
    are never touched: "none" after a search means none *of these*. */
export function Picker<T extends { id: string; name: string }>({
  items,
  selected,
  onToggle,
  subtitle,
  icon,
  empty,
  searchable = false,
  searchText = (item) => `${item.name} ${item.id}`,
  searchPlaceholder = "Search…",
}: {
  items: T[]
  selected: string[]
  onToggle: (ids: string[]) => void
  subtitle: (item: T) => React.ReactNode
  icon?: (item: T) => React.ReactNode
  empty: string
  searchable?: boolean
  searchText?: (item: T) => string
  searchPlaceholder?: string
}) {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const shown = React.useMemo(
    () => (needle ? items.filter((item) => searchText(item).toLowerCase().includes(needle)) : items),
    // searchText is an inline arrow at every call site; the items and the query are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, needle],
  )

  if (items.length === 0) {
    return <Empty>{empty}</Empty>
  }

  const shownIds = shown.map((item) => item.id)
  const allShownSelected = shown.length > 0 && shownIds.every((id) => selected.includes(id))
  const selectAll = () => onToggle([...selected, ...shownIds.filter((id) => !selected.includes(id))])
  const selectNone = () => onToggle(selected.filter((id) => !shownIds.includes(id)))

  const list =
    shown.length === 0 ? (
      <Empty>Nothing matches “{query.trim()}”.</Empty>
    ) : (
      <div className={cn("max-h-64 divide-y overflow-y-auto", INSET)}>
        {shown.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted">
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={selected.includes(item.id)}
              onCheckedChange={(checked) =>
                onToggle(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))
              }
            />
            {icon && <div className="mt-0.5 shrink-0">{icon(item)}</div>}
            <span className="min-w-0 flex-1">
              <span className="block text-sm break-words">{item.name}</span>
              <span className="mt-0.5 block font-mono text-xs break-all text-muted-foreground">
                {subtitle(item)}
              </span>
            </span>
          </label>
        ))}
      </div>
    )

  if (!searchable) return list

  const selectedShown = shownIds.filter((id) => selected.includes(id)).length
  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={searchPlaceholder}
        className="h-8"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-0.5 text-xs text-muted-foreground">
        <span>
          {selectedShown} of {shown.length} selected
          {shown.length !== items.length ? ` · ${items.length} total` : ""}
        </span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="ml-auto h-auto px-0"
          disabled={shown.length === 0 || allShownSelected}
          onClick={selectAll}
        >
          Select all
        </Button>
        <span aria-hidden>·</span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-0"
          disabled={selectedShown === 0}
          onClick={selectNone}
        >
          Select none
        </Button>
      </div>
      {list}
    </div>
  )
}

/** Every route-backed form's footer — and, since it is the one place all of
    them share, where a failed save is said. Inline rather than as a toast: the
    form stays on screen with the user's unsaved values in it, and a Save that
    silently did nothing is indistinguishable from one that worked until you
    navigate away and find it didn't. */
export function FormActions({
  busy,
  onCancel,
  error,
  submitLabel = "Save",
  leading,
  done,
}: {
  busy: boolean
  /** Omitted where the form has nothing to go back to — the Rules page is a
      section, not a route-backed form, and its Cancel was a no-op button. In a
      bar that is always on screen a button that does nothing is worse than no
      button, so there is no button. */
  onCancel?: () => void
  error?: InlineError | null
  /** The primary's label. Busy keeps it and spins (`loading`), so the button
      does not change width under the pointer. */
  submitLabel?: string
  /** At the start of the row: a Delete, a Move, a Revert, a saved state. */
  leading?: React.ReactNode
  /** An autosaving form: one primary "Done" (a button, never a submit). */
  done?: () => void
}) {
  return (
    /* Stuck to the foot of the frame rather than sitting at the end of the
       document: a profile's form is four screens on a phone, and Save was
       something you scrolled to find after every edit. `-mx`/`px` bleeds the
       bar's ground to the column's edges (the `PageFrame` gutter) so the rows
       scrolling under it are covered; `KEYBOARD_RISE` puts it above the soft
       keys, since the page does not resize when one opens and `bottom-0` would
       be behind them. */
    <footer
      className={cn(
        "sticky z-20 -mx-4 mt-2 flex flex-col gap-3 border-t bg-background px-4 pt-3 pb-[max(0.75rem,var(--safe-bottom))] @panel-sm:-mx-8 @panel-sm:px-8",
        KEYBOARD_RISE
      )}
    >
      <ErrorNote error={error ?? null} />
      <div className="flex flex-col-reverse gap-2 @panel-sm:flex-row @panel-sm:items-center @panel-sm:justify-end [&_[data-slot=button]]:pointer-coarse:h-11">
        {leading && (
          <div className="flex flex-wrap items-center gap-2 @panel-sm:mr-auto">{leading}</div>
        )}
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {done ? (
          <Button type="button" onClick={done}>
            Done
          </Button>
        ) : (
          <Button type="submit" disabled={busy} loading={busy}>
            {submitLabel}
          </Button>
        )}
      </div>
    </footer>
  )
}

/** Upload and Clear for a logo field that is otherwise a pasted URL. The image
    is chosen from the file library (which uploads too), scaled to a small
    `data:` URL (`logoFromFile`) and written into the same string the URL input
    edits, so the row needs no file store of its own. */
export function LogoUpload({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const files = useFileActions()
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Upload
      </Button>
      {value && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
          Clear
        </Button>
      )}
      <FilePicker
        open={open}
        onOpenChange={setOpen}
        accept="image/*"
        title="Choose a logo"
        onPick={([record]) =>
          void files
            .fetchFile(record)
            .then(logoFromFile)
            .then(onChange)
            .catch((err) => reportError(err, "Couldn't use that image"))
        }
      />
    </>
  )
}

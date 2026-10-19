/* ── Settings layout primitives ──
   The shared visual vocabulary of every settings page: header, group, row,
   field, picker. Pages import from here; nothing here knows which page it is
   on — which is what makes the look one edit in this file rather than twenty.

   ── The style: cards and surfaces ──
   Every group is a **card** - a filled, bordered, softly-shadowed box whose
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
   are the **device's**, so rows and controls carry `min-h-11` outright rather
   than asking a width about a finger. */
import * as React from "react"
import { ArrowLeft, Search, type LucideIcon } from "lucide-react"
import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { Button } from "@/components/ui/button"
import { FilePicker } from "@/components/files/file-picker"
import { useFileActions } from "@/lib/files"
import { logoFromFile } from "@/lib/logo-file"
import { reportError } from "@/lib/errors"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { InlineError } from "@/lib/errors"
import { KEYBOARD_RISE } from "@/lib/keyboard-inset"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-device"
import { type PageMeta } from "./sections"
import { AiFormBuilder } from "./ai-form-builder"


/** Page title block: the section's mark, title and description, with room for
    one action. The action stacks full-width under the title on a narrow panel
    so it never crowds the text; at `@panel-sm` it sits to the right.

    A hairline closes the header off from the groups: a group's label is a
    plain heading now, not a small-caps caption on a rule, so without one the
    page's own title and the first group's read as one block of headings. The
    prose is clamped at 68ch — the descriptions in `sections.ts` are long. */
export function PageHeader({
  meta,
  action,
  flush = false,
}: {
  /** `sectionMeta(...)` carries the section's icon; a page that passes a bare
      `PageMeta` simply gets no mark. */
  meta: PageMeta & { icon?: LucideIcon }
  action?: React.ReactNode
  /** A `TabBar` follows: the track is what separates the header from the page
      below it, so the header draws no rule of its own. */
  flush?: boolean
}) {
  const Icon = meta.icon
  return (
    <header
      className={cn(
        "flex flex-col gap-4 @panel-sm:flex-row @panel-sm:items-start @panel-sm:justify-between",
        flush ? "mb-4" : "mb-8 border-b pb-6"
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-4">
        {Icon && (
          <span
            aria-hidden
            className="hidden size-11 shrink-0 items-center justify-center rounded-xl border bg-card text-primary shadow-sm @panel-sm:flex"
          >
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl">
            {meta.title}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-sm/relaxed text-pretty text-muted-foreground">
            {meta.description}
          </p>
        </div>
      </div>
      {action && (
        <div className="w-full shrink-0 [&>*]:w-full @panel-sm:ml-auto @panel-sm:w-auto @panel-sm:[&>*]:w-auto">
          {action}
        </div>
      )}
    </header>
  )
}

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
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
}) {
  if (!label && !hint && !action) return null
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
      <div className="min-w-0 flex-1 basis-56">
        {label && <h2 className="text-sm font-semibold tracking-tight">{label}</h2>}
        {hint && (
          <p className="mt-0.5 max-w-[68ch] text-xs/relaxed text-pretty text-muted-foreground">{hint}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  )
}

/** The page's vertical rhythm, in one place: every block is `Section`, and
    every `Section` is 32px from the next. */
export function Section({
  label,
  hint,
  action,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section data-kit-block className="mt-8 first:mt-0">
      <SectionHead label={label} hint={hint} action={action} />
      {children}
    </section>
  )
}

/** The card of a `Group`/`FormSection`. A container, so a tile grid inside
    answers to the card's width, and `overflow-hidden` so a full-bleed child
    (a table, a scroller that reaches out with `-mx-3`) is clipped to the
    card's radius instead of squaring off its corners. */
const CARD = "@container min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm"

/** The first of four page shapes (see "The kit" below): a heading over one
    card whose rows are divided by hairlines. */
export function Group({
  label,
  hint,
  action,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Section label={label} hint={hint} action={action}>
      <div className={cn(CARD, "divide-y divide-border/60 px-3 @panel-sm:px-4")}>{children}</div>
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
            <div className="mt-0.5 text-xs/relaxed break-words text-muted-foreground">{subtitle}</div>
          )}
        </div>
      </div>
      {/* Wrapped below the text on a narrow panel, the cluster keeps its right
          edge rather than sliding under the label: a column of controls that
          all end on one line is scannable, and a Switch on the left of a wide
          empty row reads as a bullet. */}
      {children && (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div>
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
export const INSET = "rounded-lg border border-border/60 bg-muted/30"

export function EmptyCard({ icon, text, action }: { icon: LucideIcon; text: string; action?: React.ReactNode }) {
  return (
    <Empty size="lg" icon={icon} action={action}>
      {text}
    </Empty>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="max-w-[68ch] text-[11px]/relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Labeled group of Fields inside a form - `Group`'s heading and card, with
    the fields stacked inside it rather than divided into rows, so a form reads
    as the same object a list does. `id` is the target of a `SectionRail`. */
export function FormSection({
  label,
  hint,
  action,
  id,
  children,
}: {
  label: string
  hint?: React.ReactNode
  action?: React.ReactNode
  id?: string
  children: React.ReactNode
}) {
  return (
    <div id={id} data-kit-block className="scroll-mt-[calc(var(--app-header-h)+1rem)] mt-8 first:mt-0">
      <SectionHead label={label} hint={hint} action={action} />
      <div className={cn(CARD, "space-y-4 p-3 @panel-sm:p-4")}>{children}</div>
    </div>
  )
}

export function FormPageHeader({
  title,
  description,
  onBack,
  flush = false,
}: {
  title: string
  description?: string
  onBack: () => void
  /** A `TabBar` / `FormShell` bar follows: the track takes the rule's place. */
  flush?: boolean
}) {
  return (
    /* A `FormShell` bar right after the header takes the rule's place (`:has`), so
        no form has to remember `flush` and none can stack a rule over a track. */
    <header
      className={cn(
        flush ? "mb-4" : "mb-8 border-b pb-6",
        "[&:has(+div>nav[aria-label='Form sections'])]:mb-4 [&:has(+div>nav[aria-label='Form sections'])]:border-b-0 [&:has(+div>nav[aria-label='Form sections'])]:pb-0"
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mb-3 h-11 text-muted-foreground @panel-sm:h-8"
        onClick={onBack}
      >
        <ArrowLeft />
        Back
      </Button>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-[68ch] text-sm/relaxed text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </header>
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
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
}

/** Two to four numbers about the page, under its header. 2-up on a phone,
    one row from `@panel-sm`. Not interactive: a number you can click is a
    filter, and filters are the `Toolbar`'s. */
export function StatStrip({
  stats,
}: {
  stats: { label: string; value: React.ReactNode; hint?: string; tone?: Tone }[]
}) {
  return (
    <dl
      className={cn(
        "mb-8 grid grid-cols-2 gap-3",
        stats.length === 3 ? "@panel-sm:grid-cols-3" : stats.length >= 4 ? "@panel-sm:grid-cols-4" : "@panel-sm:grid-cols-2"
      )}
    >
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0 rounded-xl border bg-card px-4 py-3 shadow-sm">
          <dt className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{stat.label}</dt>
          <dd className={cn("mt-1 truncate text-xl font-semibold tabular-nums", TONE_TEXT[stat.tone ?? "default"])}>
            {stat.value}
          </dd>
          {stat.hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{stat.hint}</p>}
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
        <div className="relative min-w-0 flex-1 @panel-sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search ?? ""}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder.replace(/\.{3}|\u2026$/, "")}
            className="h-11 pl-9 @panel-sm:h-9"
          />
        </div>
      )}
      {chips && onChip && (
        <Segmented
          label="Filter"
          value={chip ?? ""}
          onChange={onChip}
          options={chips.map((entry) => ({ value: entry.id, label: entry.label, count: entry.count }))}
        />
      )}
      {children && <div className="flex shrink-0 items-center gap-1.5 @panel-sm:ml-auto">{children}</div>}
    </div>
  )
}

/** The one grid: 1 column on a phone, as many 18rem-plus columns as fit. */
export function CardGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]", className)}>
      {children}
    </div>
  )
}

/** The one card of a collection: a mark, a title and subtitle, badges, a
    preview, an optional body (pickers, meters), and a footer of actions.
    `onOpen` makes the head the click target (a link into the item); `active`
    tints it (the server you are on, the agent being read). Actions are in the
    footer, never over the head, so a card is one target and one row of
    buttons - not a button inside a button. */
export function ItemCard({
  icon,
  title,
  subtitle,
  badges,
  preview,
  active,
  onOpen,
  actions,
  handle,
  children,
}: {
  /** A Lucide component or an already-rendered element (a profile's logo). */
  icon?: LucideIcon | React.ReactElement
  title: React.ReactNode
  subtitle?: React.ReactNode
  badges?: React.ReactNode
  preview?: React.ReactNode
  active?: boolean
  onOpen?: () => void
  actions?: React.ReactNode
  /** A drag grip, for a list whose order is the user's. */
  handle?: React.ReactNode
  children?: React.ReactNode
}) {
  const head = (
    <>
      {icon && (
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            active ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
          )}
        >
          {React.isValidElement(icon) ? icon : (() => { const Icon = icon as LucideIcon; return <Icon className="size-4" /> })()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </>
  )
  return (
    <article
      className={cn(
        "@container flex min-w-0 flex-col rounded-xl border bg-card shadow-sm transition-colors",
        active && "border-primary/50 bg-primary/[0.03]"
      )}
    >
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          {handle}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {head}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">{head}</div>
          )}
        </div>
        {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
        {preview && <div className="line-clamp-2 text-xs/relaxed text-muted-foreground">{preview}</div>}
        {children}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">{actions}</div>
      )}
    </article>
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

/** The one in-page switch: a track of tabs under the page header, on every page
    and at every width. A recessed ground with the current tab raised out of it,
    the same thumb `Segmented` wears - both answer "which one of these", and the
    icons and counts are the part a *page* needs that a value picker does not.

    It is **not sticky**. A page's tabs belong to the top of the page and scroll
    away with it: nothing floats over the rows somebody is reading, and the app
    header never has a second bar parked under it. Navigation that follows you
    is the sidebar's job, and it is the only thing that does.

    Overflow scrolls sideways rather than wrapping or turning into a dropdown - a
    phone shows the same tabs the desktop does. `nav` mode is for anchors
    (`FormShell`): same look, `aria-current` instead of `role=tab`, because
    jumping to a section is not switching a panel. Pair with `PageHeader flush`,
    which drops the header's rule: the track is the break. */
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
      ref={(node: HTMLElement | null) => {
        barRef.current = node
      }}
      {...(nav ? { "aria-label": label } : { role: "tablist", "aria-label": label })}
      onKeyDown={nav ? undefined : onKeyDown}
      className={cn(
        "mb-8 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border/60 bg-muted/50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
              "relative inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @panel-sm:h-9",
              /* The thumb is the card's own ground with a hairline around it:
                 `--card` and `--muted` are two per cent apart in a dark palette,
                 so a fill alone leaves the current tab unfindable there. */
              active
                ? "border-border bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
            )}
          >
            {Icon && (
              <Icon
                className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground/70")}
                aria-hidden
              />
            )}
            {item.label}
            {item.count !== undefined && (
              <span className="min-w-4 rounded-full bg-foreground/10 px-1.5 text-center text-[11px] font-medium tabular-nums">
                {item.count}
              </span>
            )}
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
    <div>
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
    Connected | Error, Export | Import. A pill track with a raised thumb;
    `radiogroup` with arrow keys. More than ~5 options, or long labels, is a
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
        "flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
              "inline-flex h-10 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none @panel-sm:h-8",
              selected ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
            {option.label}
            {option.count !== undefined && <span className="tabular-nums text-muted-foreground">{option.count}</span>}
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
              "flex min-h-20 min-w-0 flex-col items-stretch justify-center gap-1.5 rounded-lg border p-2.5 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-primary/60 bg-primary/5 text-foreground shadow-sm" : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            )}
          >
            {choice.preview ?? (Icon && <Icon className={cn("mx-auto size-5", selected && "text-primary")} aria-hidden />)}
            <span className="truncate">{choice.label}</span>
            {choice.hint && <span className="truncate text-[11px] font-normal text-muted-foreground">{choice.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

export type StatusTone = "ok" | "warn" | "bad" | "info" | "neutral"
const STATUS_CLASS: Record<StatusTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-destructive/10 text-destructive",
  info: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
}
const STATUS_DOT: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  info: "bg-primary",
  neutral: "bg-muted-foreground/60",
}

/** A state, said one way everywhere: connected, needs auth, default, missing.
    A dot, a word, a tone - never a bare colour (the word is the accessible
    half) and never a one-off `bg-emerald-500` in a page. */
export function StatusBadge({ tone = "neutral", dot = true, children }: { tone?: StatusTone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", STATUS_CLASS[tone])}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[tone])} />}
      {children}
    </span>
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
      <div className={cn("max-h-64 divide-y divide-border/60 overflow-y-auto", INSET)}>
        {shown.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/50">
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
              <span className="mt-0.5 block font-mono text-[11px] break-all text-muted-foreground">
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
          size="sm"
          className="ml-auto h-auto p-0 text-xs"
          disabled={shown.length === 0 || allShownSelected}
          onClick={selectAll}
        >
          Select all
        </Button>
        <span aria-hidden>·</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
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
}: {
  busy: boolean
  /** Omitted where the form has nothing to go back to — the Rules page is a
      section, not a route-backed form, and its Cancel was a no-op button. In a
      bar that is always on screen a button that does nothing is worse than no
      button, so there is no button. */
  onCancel?: () => void
  error?: InlineError | null
}) {
  return (
    /* Stuck to the foot of the frame rather than sitting at the end of the
       document: a profile's form is four screens on a phone, and Save was
       something you scrolled to find after every edit. `-mx`/`px` bleeds the
       bar's ground to the column's edges so the rows scrolling under it are
       covered; `KEYBOARD_RISE` puts it above the soft keys, since the page does
       not resize when one opens and `bottom-0` would be behind them. */
    <footer
      className={cn(
        "sticky z-20 -mx-4 mt-2 flex flex-col gap-3 border-t bg-background px-4 pt-3 pb-[max(0.75rem,var(--safe-bottom))] @panel-sm:-mx-8 @panel-sm:px-8",
        KEYBOARD_RISE
      )}
    >
      <ErrorNote error={error ?? null} />
      <div className="flex flex-col-reverse gap-2 @panel-sm:flex-row @panel-sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" className="h-11 @panel-sm:h-9" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="h-11 @panel-sm:h-9" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
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

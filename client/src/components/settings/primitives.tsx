/* ── Settings layout primitives ──
   The shared visual vocabulary of every settings page: header, group, row,
   field, picker. Pages import from here; nothing here knows which page it is
   on — which is what makes the look one edit in this file rather than twenty.

   ── The style: cards and surfaces ──
   Every group is a **card** — a caption in small caps above it, then a filled,
   bordered, softly-shadowed box whose rows are divided by hairlines. A settings
   page is a list of lists, and a card is what says where one list stops and the
   next begins without asking the reader to count blank space.

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
import { ArrowLeft, type LucideIcon } from "lucide-react"
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
import { type PageMeta } from "./sections"


/** Page title block: title + description, with room for one action. The
    action stacks full-width under the title on a narrow panel so it never
    crowds the text or wraps awkwardly; at `@panel-sm` it sits to the right.

    No bottom rule: the first group's caption already draws one a line below,
    and two hairlines a paragraph apart is a header boxed off from the page it
    titles. The prose is clamped at 68ch — the descriptions in `sections.ts`
    are long, and a 90-character line in a wide panel is one an eye loses. */
export function PageHeader({
  meta,
  action,
}: {
  meta: PageMeta
  action?: React.ReactNode
}) {
  return (
    <header className="mb-8 flex flex-col gap-4 @panel-sm:flex-row @panel-sm:items-start @panel-sm:justify-between">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl">
          {meta.title}
        </h1>
        <p className="mt-2 max-w-[68ch] text-sm/relaxed text-pretty text-muted-foreground">
          {meta.description}
        </p>
      </div>
      {action && (
        <div className="w-full shrink-0 [&>*]:w-full @panel-sm:ml-auto @panel-sm:w-auto @panel-sm:[&>*]:w-auto">
          {action}
        </div>
      )}
    </header>
  )
}

/** One section: a caption above a card, then the card's rows divided by
    hairlines. `hint` is a line under the caption for a group that needs a
    sentence of its own — the page description cannot say something true of
    only four of its twelve rows, and it sits *outside* the card because it is
    about the card rather than a row in it.

    The caption is not sticky. It was, back when a group was a caption on a
    hairline and there was nothing to tell you which list you were in halfway
    down it; a card's own edges say that, and a small-caps label unsticking
    itself from a rounded corner as you scroll is a seam that draws the eye to
    nothing. */
export function Group({
  label,
  hint,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-8 first:mt-0">
      {label && (
        <h2 className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {label}
        </h2>
      )}
      {hint && (
        <p className="mb-2 max-w-[68ch] px-1 text-xs/relaxed text-muted-foreground">{hint}</p>
      )}
      {/* `overflow-hidden` so a full-bleed child (a table, a scroller that
          reaches out with `-mx-3`) is clipped to the card's radius instead of
          squaring off its corners. */}
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card px-3 shadow-sm @panel-sm:px-4">
        {children}
      </div>
    </section>
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

/** Labeled group of Fields inside a form — `Group`'s caption and card, with
    the fields stacked inside it rather than divided into rows, so a form reads
    as the same object a list does. */
export function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </h3>
      <div className="space-y-4 rounded-xl border bg-card p-3 shadow-sm @panel-sm:p-4">
        {children}
      </div>
    </section>
  )
}

export function FormPageHeader({
  title,
  description,
  onBack,
}: {
  title: string
  description?: string
  onBack: () => void
}) {
  return (
    <header className="mb-8">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mb-3 h-8 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft />
        Back
      </Button>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-2 max-w-[68ch] text-sm/relaxed text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </header>
  )
}

/** Shared vertical rhythm for every route-backed form. */
export function PageForm({ className, ...props }: React.ComponentProps<"form">) {
  return <form className={cn("space-y-6", className)} {...props} />
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
        onPick={(record) =>
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

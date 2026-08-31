/* ── Settings layout primitives ──
   The shared visual vocabulary of every settings page: header, grouped card,
   row, field, picker. Pages import from here; nothing here knows which page
   it is on. */
import * as React from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import { ErrorNote } from "@/components/error-note"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { InlineError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { type SectionMeta } from "./sections"


/** Page title block: title + description, with room for one action. On
    mobile the action stacks full-width under the title so it never crowds the
    text or wraps awkwardly; on sm+ it sits to the right. */
export function PageHeader({ meta, action }: { meta: SectionMeta; action?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{meta.title}</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">{meta.description}</p>
      </div>
      {action && (
        <div className="w-full shrink-0 [&>*]:w-full sm:ml-auto sm:w-auto sm:[&>*]:w-auto">
          {action}
        </div>
      )}
    </header>
  )
}

/** Grouped card with an optional caption above it. */
export function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      {label && (
        <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
      )}
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
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
    `sm:flex-nowrap` keeps every row on one line once there is room for one. */
export function Row({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  /** A Lucide component, or an already-rendered element (a profile's logo). */
  icon?: LucideIcon | React.ReactElement
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap">
      {Icon &&
        (React.isValidElement(Icon) ? Icon : <Icon className="size-4 shrink-0 text-muted-foreground" />)}
      <div className="min-w-0 grow basis-48">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs break-all text-muted-foreground">{subtitle}</div>}
      </div>
      {children && (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div>
      )}
    </div>
  )
}

export function EmptyCard({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Labeled group of Fields inside a form dialog — Group's caption, without the card. */
export function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
      {children}
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
    <header className="mb-6 border-b pb-5">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
        {description && <p className="mt-1 max-w-[65ch] text-sm text-pretty text-muted-foreground">{description}</p>}
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
  empty,
  searchable = false,
  searchText = (item) => `${item.name} ${item.id}`,
  searchPlaceholder = "Search…",
}: {
  items: T[]
  selected: string[]
  onToggle: (ids: string[]) => void
  subtitle: (item: T) => React.ReactNode
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
    return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{empty}</p>
  }

  const shownIds = shown.map((item) => item.id)
  const allShownSelected = shown.length > 0 && shownIds.every((id) => selected.includes(id))
  const selectAll = () => onToggle([...selected, ...shownIds.filter((id) => !selected.includes(id))])
  const selectNone = () => onToggle(selected.filter((id) => !shownIds.includes(id)))

  const list =
    shown.length === 0 ? (
      <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
        Nothing matches “{query.trim()}”.
      </p>
    ) : (
      <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
        {shown.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/50">
            <Checkbox
              className="mt-0.5"
              checked={selected.includes(item.id)}
              onCheckedChange={(checked) =>
                onToggle(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))
              }
            />
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
      <div className="flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
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
  onCancel: () => void
  error?: InlineError | null
}) {
  return (
    <footer className="flex flex-col gap-3 border-t pt-4">
      <ErrorNote error={error ?? null} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </footer>
  )
}

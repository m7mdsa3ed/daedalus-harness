/* ── Settings layout primitives ──
   The shared visual vocabulary of every settings page: header, grouped card,
   row, field, picker. Pages import from here; nothing here knows which page
   it is on. */
import * as React from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
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

/** One line in a Group: label/description on the left, control on the right. */
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
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs break-all text-muted-foreground">{subtitle}</div>}
      </div>
      {children && <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>}
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
    <header className="mb-6 flex items-start gap-3 border-b pb-5">
      <Button type="button" variant="ghost" size="icon-lg" className="mt-0.5 shrink-0" onClick={onBack}>
        <ArrowLeft />
        <span className="sr-only">Back</span>
      </Button>
      <div className="min-w-0 flex-1">
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

/** Checkbox list for linking library entries (MCP servers, skills) to a project. */
export function Picker<T extends { id: string; name: string }>({
  items,
  selected,
  onToggle,
  subtitle,
  empty,
}: {
  items: T[]
  selected: string[]
  onToggle: (ids: string[]) => void
  subtitle: (item: T) => React.ReactNode
  empty: string
}) {
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
      {items.map((item) => (
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
}

export function FormActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </footer>
  )
}

/* ── Pieces for a page that has a history ──
   The project overview, the routines and the schedules are the same kind of
   screen: a thing with a name, a few numbers about what it has done, and the
   list of what it did. Settings' primitives are for a form; these are for that
   reading. Nothing here knows which surface it is on. */
import * as React from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/** A page's title block: an optional way back, a title over a description or a
    line of badges, and the page's actions trailing. On a phone the actions
    drop under the text and stretch; on sm+ they sit beside it. */
export function SurfaceHeader({
  icon,
  title,
  description,
  meta,
  onBack,
  actions,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Small facts under the title — a project, an agent, a state. */
  meta?: React.ReactNode
  onBack?: () => void
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("mb-6 border-b pb-5", className)}>
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mb-3 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft />
          Back
        </Button>
      )}
      <div className="flex flex-wrap items-start gap-4">
        {icon && <div className="shrink-0">{icon}</div>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
          {description && (
            <p className="mt-1 max-w-[65ch] text-sm text-pretty text-muted-foreground">
              {description}
            </p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:shrink-0">
            {actions}
          </div>
        )}
      </div>
    </header>
  )
}

/** One fact about the page's subject, with an icon beside its name. */
export function MetaFact({
  icon: Icon,
  children,
  title,
  className,
}: {
  icon?: LucideIcon
  children: React.ReactNode
  title?: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={title}>
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** One number, its name and a line saying what the number is about. The value
    is skeletoned rather than zeroed while its read is out: a 0 that turns into
    400 is a statement the page made and then took back. */
export function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  loading,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: React.ReactNode
  hint: string
  loading?: boolean
  /** Colour the value — for a state that is a warning rather than a count. */
  tone?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className={cn("mt-1.5 truncate text-2xl font-semibold tabular-nums", tone)}>
        {loading ? <Skeleton className="h-7 w-16" /> : value}
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={hint}>
        {hint}
      </p>
    </div>
  )
}

/** The tiles in a row, four across where there is room. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
}

/** A bordered card with a caption, for the lists on a page. */
export function SurfaceCard({
  title,
  action,
  children,
  className,
}: {
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

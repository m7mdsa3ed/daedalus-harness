/* ── Pieces for a page that has a history ──
   The project overview, the routines and the schedules are the same kind of
   screen: a thing with a name, a few numbers about what it has done, and the
   list of what it did. Settings' primitives are for a form; these are for that
   reading. Nothing here knows which surface it is on. */
import * as React from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/* How wide a page's column may get. `form` is a form's measure, `settings` the
   settings frame's, `wide` a page with tiles and two columns (the project
   page, a schedule, a routine, a trace), `full` no cap at all. */
const PAGE_WIDTH = {
  form: "mx-auto max-w-3xl",
  settings: "mx-auto max-w-5xl",
  wide: "mx-auto max-w-5xl",
  full: "",
} as const

/** The frame every scrolling page route sits in: a scroller that pads for the
    app header (`--app-header-h`, re-pointed per page tab by `page-panel.tsx`)
    and a centred column inside it. `min-w-0`, or a wide row (a textarea, a
    table) makes the flex item refuse to shrink and the page scrolls sideways.
    `gutter` is where the side padding steps up: the viewport's `sm` (every page
    that has always used it) or the panel's `@panel-sm` (settings). */
export function PageFrame({
  width = "wide",
  gutter = "viewport",
  scrollRef,
  className,
  children,
}: {
  width?: keyof typeof PAGE_WIDTH
  gutter?: "viewport" | "panel"
  scrollRef?: React.Ref<HTMLDivElement>
  /** Extra classes on the column (not the scroller). */
  className?: string
  children: React.ReactNode
}) {
  return (
    <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
      <div
        className={cn(
          "w-full px-4 pt-6 pb-16",
          gutter === "panel" ? "@panel-sm:px-8" : "sm:px-8",
          PAGE_WIDTH[width],
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

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
  flush = false,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Small facts under the title — a project, an agent, a state. */
  meta?: React.ReactNode
  onBack?: () => void
  actions?: React.ReactNode
  /** A tab bar follows: it draws the rule, so the header does not. */
  flush?: boolean
  className?: string
}) {
  return (
    <header className={cn(flush ? "mb-4" : "mb-8 border-b pb-6", className)}>
      {onBack && (
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
      )}
      <div className="flex flex-col gap-4 @panel-sm:flex-row @panel-sm:items-start">
        {icon && <div className="shrink-0">{icon}</div>}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl">{title}</h1>
          {description && (
            <p className="mt-1.5 max-w-[68ch] text-sm/relaxed text-pretty text-muted-foreground">
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
          <div className="flex w-full flex-wrap items-center gap-2 @panel-sm:ml-auto @panel-sm:w-auto @panel-sm:shrink-0">
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
    <Card size="sm" className="gap-1 px-4">
      <CardDescription className="flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
      </CardDescription>
      <div className={cn("truncate text-2xl font-semibold tabular-nums", tone)}>
        {loading ? <Skeleton className="h-8 w-16" /> : value}
      </div>
      <p className="truncate text-xs text-muted-foreground" title={hint}>
        {hint}
      </p>
    </Card>
  )
}

/** The tiles in a row, four across where there is room. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 @panel-sm:grid-cols-2 @panel-lg:grid-cols-4">{children}</div>
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
    <Card className={cn("gap-0 py-0", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {action}
      </div>
      {children}
    </Card>
  )
}

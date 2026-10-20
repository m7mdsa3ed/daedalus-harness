/* ── Pieces for a page that has a history ──
   The project overview, the routines and the schedules are the same kind of
   screen: a thing with a name, a few numbers about what it has done, and the
   list of what it did. Settings' primitives are for a form; these are for that
   reading. Nothing here knows which surface it is on. */
import * as React from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/* How wide a page's column may get. `wide` is every list, detail, dashboard
   and settings section; `form` is a single form's measure (the landing setup);
   `xl` the two surfaces that are several panes side by side (Settings › Files,
   the theme studio). */
const PAGE_WIDTH = {
  form: "mx-auto max-w-3xl",
  wide: "mx-auto max-w-5xl",
  xl: "mx-auto max-w-7xl",
} as const

/** The h1 every page header draws, in one place. */
export const PAGE_TITLE = "font-heading text-xl font-semibold tracking-tight text-balance @panel-sm:text-2xl"

/** The frame every scrolling page route sits in: a scroller that pads for the
    app header (`--app-header-h`, re-pointed per page tab by `page-panel.tsx`)
    and a centred column inside it. `min-w-0`, or a wide row (a textarea, a
    table) makes the flex item refuse to shrink and the page scrolls sideways.
    One gutter for every page, stepped up on the *panel's* width; `pb-24`
    leaves room under the last block for a sticky `FormActions` and the home
    indicator. */
export function PageFrame({
  width = "wide",
  scrollRef,
  className,
  children,
}: {
  width?: keyof typeof PAGE_WIDTH
  scrollRef?: React.Ref<HTMLDivElement>
  /** Extra classes on the column (not the scroller). */
  className?: string
  children: React.ReactNode
}) {
  return (
    <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
      <div className={cn("w-full px-4 pt-6 pb-24 @panel-sm:px-8", PAGE_WIDTH[width], className)}>
        {children}
      </div>
    </div>
  )
}

/* A track (a `TabBar`, a form's `FormShell` bar) right after the header is
   what separates it from the page, so the header drops its own rule — read off
   the DOM (`data-kit-track`), so no caller has to remember to say `flush`. */
const TRACK_FOLLOWS =
  "[&:has(+[data-kit-track])]:mb-4 [&:has(+[data-kit-track])]:border-b-0 [&:has(+[data-kit-track])]:pb-0 " +
  "[&:has(+form>[data-kit-track])]:mb-4 [&:has(+form>[data-kit-track])]:border-b-0 [&:has(+form>[data-kit-track])]:pb-0 " +
  "[&:has(+form>*>[data-kit-track])]:mb-4 [&:has(+form>*>[data-kit-track])]:border-b-0 [&:has(+form>*>[data-kit-track])]:pb-0"

/* A Lucide icon is a forwardRef object (or a function): not an element, and
   not an array of nodes. */
const isComponent = (icon: unknown): icon is LucideIcon =>
  typeof icon === "function" ||
  (typeof icon === "object" && icon !== null && !React.isValidElement(icon) && "$$typeof" in icon)

/** The one page header: an optional way back (drill-down pages only), the
    page's mark, a title over a description and a line of facts, and the page's
    actions trailing. On a narrow panel the actions drop under the text and
    stretch; from `@panel-sm` they sit beside it at their own width. */
export function SurfaceHeader({
  icon,
  title,
  description,
  meta,
  onBack,
  actions,
  className,
}: {
  /** A Lucide component (drawn on a muted tile) or an entity's own mark,
      already sized (`size-10`). Hidden on a narrow panel. */
  icon?: LucideIcon | React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Small facts under the title — a project, an agent, a state. */
  meta?: React.ReactNode
  onBack?: () => void
  actions?: React.ReactNode
  /** A no-op alias kept for old callers: the rule drops by itself when a
      track follows. */
  flush?: boolean
  className?: string
}) {
  const Icon = isComponent(icon) ? icon : null
  return (
    <header className={cn("mb-8 border-b pb-6", TRACK_FOLLOWS, className)}>
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mb-3 text-muted-foreground pointer-coarse:h-11"
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      )}
      <div className="flex flex-col gap-4 @panel-sm:flex-row @panel-sm:items-start">
        {Icon ? (
          <span
            aria-hidden
            className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground @panel-sm:flex"
          >
            <Icon className="size-5" />
          </span>
        ) : (
          icon && (
            <div className="hidden size-10 shrink-0 items-center justify-center @panel-sm:flex">
              {icon as React.ReactNode}
            </div>
          )
        )}
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>{title}</h1>
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
          <div className="flex w-full flex-wrap items-center gap-2 *:grow @panel-sm:ml-auto @panel-sm:w-auto @panel-sm:shrink-0 @panel-sm:*:grow-0 [&_[data-slot=button]]:pointer-coarse:min-h-11 [&_[data-slot=button]]:pointer-coarse:min-w-11">
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

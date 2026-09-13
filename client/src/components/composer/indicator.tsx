/* ── The shape every reading of the thread wears ──
   `StripIndicator` — the 24px trigger over a popover that the composer
   footer's end cluster is made of — and `Ring`, the dial two of those
   readings print a number inside. Everything else in this folder that draws a
   reading is one of them; nothing here knows what is being read. */
import * as React from "react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export function Ring({ percent, className }: { percent: number; className?: string }) {
  const radius = 8.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg aria-hidden viewBox="0 0 24 24" className={cn("size-6 -rotate-90", className)}>
      <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="2" stroke="currentColor" className="opacity-15" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  )
}

/* ── One row of marks, so one size ──
   The kernel of the cluster: a 24px ghost button (`icon-xs`), a 16px mark, a
   count that rides the mark on a narrow panel and becomes a text badge on a
   wide one. Every reading wears these three, and the dials are no exception —
   a 24px dial beside a 14px glyph is two rows pretending to be one, which is
   exactly what it looked like. */

/** How big a reading's mark is — the dial in `Ring` or a lucide glyph. */
export const READING_MARK = "size-4"

/** The button geometry, minus the mark's own colour. */
export const READING_TRIGGER =
  "relative shrink-0 rounded-pill @panel-sm:w-auto! @panel-sm:gap-1 @panel-sm:px-1.5"

/**
 * The count that rides the mark on a narrow panel — the badge's other dress.
 *
 * Never both at once: a reading that has room to write its count in words wears
 * the badge and hides this, and one that does not wears this. `min-w` rather
 * than a fixed `size`, so a two-character count (`42`, `9+`) still fits the
 * pill without pushing the mark off its 24px square.
 */
export function ReadingBubble({
  children,
  tone = "primary",
  className,
}: {
  children: React.ReactNode
  tone?: "primary" | "secondary"
  className?: string
}) {
  return (
    <span
      className={cn(
        "absolute -end-0.5 -top-0.5 grid h-3 min-w-3 place-items-center rounded-full px-0.5 text-[8px] font-semibold tabular-nums @panel-sm:hidden",
        tone === "primary"
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-secondary-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * The words a reading grows on a wide panel.
 *
 * A badge, not a word floating beside the mark: small (10px — under the
 * button's own `text-sm`, and the same ring the app's `Badge` and `ChipBadge`
 * sit on), with a ground of its own (`bg-muted`) so it reads as a label clipped
 * onto the icon rather than as loose text. It carries the panel breakpoint
 * itself (`hidden @panel-sm:inline`), so a reading never has to remember when
 * it may speak — it asks for the badge and the width decides.
 */
export function ReadingBadge({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "hidden rounded-md bg-muted px-1.5 py-px text-[10px] leading-none font-medium whitespace-nowrap @panel-sm:inline",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * A reading in the composer footer's end cluster.
 *
 * One shape for every reading of this kind: the icon alone where the panel is
 * narrow, the icon beside its label where there is room for words, and a
 * popover carrying the detail. The label's breakpoint is the *panel's*
 * (`@panel-sm`), never the viewport's — a chat squeezed beside a terminal is
 * narrow for the same reason a phone is, and it is the width that decides
 * whether there is room to write in. The square stays 24px either way, so a
 * cluster of these still reads as a row of marks rather than as a row of
 * buttons that grew a word.
 *
 * New readings belong here rather than as another row above the composer: a
 * thing that is true of the thread right now is one number, glanced at
 * constantly and read in full rarely, which is what a trigger over a popover
 * is for.
 */
export function StripIndicator({
  icon,
  label,
  heading,
  title,
  tone,
  badge,
  side = "top",
  width = "w-72",
  action,
  children,
}: {
  icon: React.ReactNode
  /** Written beside the icon where the panel has room, and the accessible
      name everywhere. Short: it sits in a row of marks that are all short. */
  label: string
  /** The popover's title, where the label is too clipped to carry it. */
  heading?: string
  /** Overrides the tooltip when the label alone is not the whole answer. */
  title?: string
  /** The trigger's text tone. A reading that wants attention says so; the
      default is a settled fact. */
  tone?: string
  /** A count riding the mark. Secondary and not primary: something already
      finished is not something still running. */
  badge?: React.ReactNode
  side?: "top" | "bottom"
  width?: string
  /** The one thing to do about it, at the foot of the popover. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            /* w-auto on a wide panel is what lets the label in; `!` because
               `size-6` sets width too and the two are one property apart. */
            className={cn(READING_TRIGGER, "text-muted-foreground hover:text-foreground", tone)}
            title={title ?? label}
            aria-label={title ?? label}
          >
            {icon}
            <ReadingBadge>{label}</ReadingBadge>
            {badge}
          </Button>
        }
      />
      <PopoverContent align="end" side={side} className={cn(width, "gap-2")}>
        <p className="font-medium">{heading ?? label}</p>
        {children}
        {action}
      </PopoverContent>
    </Popover>
  )
}

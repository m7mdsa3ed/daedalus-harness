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

export function Ring({ percent }: { percent: number }) {
  const radius = 8.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6 -rotate-90">
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
            className={cn(
              "relative shrink-0 gap-1 rounded-lg px-1.5 text-muted-foreground hover:text-foreground",
              "@panel-sm:w-auto!",
              tone
            )}
            title={title ?? label}
            aria-label={title ?? label}
          >
            {icon}
            <span className="hidden @panel-sm:inline">{label}</span>
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

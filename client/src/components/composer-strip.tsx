/* ── The composer strip ──
   The shelf above the composer card: one tinted surface, tucked under the
   card's top edge, holding three bands top to bottom —

   — **the pile**: what is about the message being typed (attachments, the
     "Earlier prompt" notice, the `/` `!` `@` completers). Drawn flat, one row
     each, and only while there is something in it;
   — **the panel**: the detail of one reading, expanded *in flow* when a
     segment of the bar is picked — the model, the tools, the checklist, the
     window. It pushes the card down rather than floating over it, which is the
     whole point: nothing on the composer opens a popover;
   — **the bar**: the thread's scope and readings as one compact line, always
     drawn, on both sides of the first message.

   The strip knows none of what is in those bands; the composer passes them.

   ── The tone ──
   The shelf's ground is the thesis that nothing on it is alarming. A connection
   that is not well is the one thing that has to say so at a glance, so the
   ground itself takes a tone (`bg-shelf-*`, derived per mode in index.css) —
   one key here, and what a tone means is `connectionTone`'s business. */
import * as React from "react"

import { cn } from "@/lib/utils"

export type StripTone = "neutral" | "info" | "warn" | "error"

const TONE_GROUND: Record<StripTone, string> = {
  neutral: "bg-shelf",
  info: "bg-shelf-info",
  warn: "bg-shelf-warn",
  error: "bg-shelf-error",
}

/** How far the shelf runs under the card. The card is `relative z-10`, so it
    paints over this much of the shelf's foot. */
const TUCK = "pb-5 -mb-3.5"

export function ComposerStrip({
  tone = "neutral",
  bar,
  panel,
  children,
}: {
  tone?: StripTone
  /** The always-drawn line at the shelf's foot. */
  bar?: React.ReactNode
  /** The expanded detail, or nothing when no segment is open. */
  panel?: React.ReactNode
  /** The pile. Rows that have nothing to say render null and take no room. */
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="composer-strip"
      className={cn(
        "mx-auto flex w-[calc(100%-1.5rem)] max-w-[calc(var(--harness-composer-width)-1.5rem)] flex-col rounded-t-2xl px-1 pt-1 transition-colors duration-300",
        TONE_GROUND[tone],
        TUCK
      )}
    >
      {/* `empty:hidden`: a pile whose rows all rendered null is no band at all. */}
      <div className="flex flex-col divide-y divide-foreground/[0.06] empty:hidden [&:not(:empty)]:pb-1">
        {children}
      </div>
      {panel && (
        <div className="mb-1 overflow-hidden rounded-xl bg-background/70 ring-1 ring-foreground/[0.06]">
          {panel}
        </div>
      )}
      {bar}
    </div>
  )
}

/** One row of the pile: a plain block. The rows own their own padding. */
export function ComposerStripItem({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn("min-w-0", className)}>{children}</div>
}

/* ── The shape every reading of the thread wears ──
   `StripIndicator` — the 24px trigger over a popover that the composer
   footer's end cluster is made of — and `Ring`, the dial two of those
   readings print a number inside. Everything else in this folder that draws a
   reading is one of them; nothing here knows what is being read. */
import * as React from "react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ChipBadge } from "@/components/composer-strip"
import { PanelRightOpenIcon } from "lucide-react"
import { useOpenInspector, type InspectorTab } from "@/lib/inspector"
import { cn } from "@/lib/utils"

/** The last row of a reading's popover: the same reading, full height, in the
    thread's inspector. Draws nothing where there is no inspector to open (the
    landing console's composer). `onOpen` closes the popover first. */
export function OpenInInspector({
  tab,
  onOpen,
  label = "Open in inspector",
}: {
  tab: InspectorTab
  onOpen?: () => void
  label?: string
}) {
  const open = useOpenInspector()
  if (!open) return null
  return (
    <Button
      variant="ghost"
      size="xs"
      className="-mx-1 -mb-1 justify-start text-muted-foreground hover:text-foreground"
      onClick={() => {
        onOpen?.()
        open(tab)
      }}
    >
      <PanelRightOpenIcon aria-hidden data-icon="inline-start" />
      {label}
    </Button>
  )
}

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

/* ── One row of faces, so one size ──
   The kernel of the cluster: a 24px ghost button (`icon-xs`) holding a *face* —
   the mark where the panel is narrow, and the mark inside a pill with its words
   where there is room. Every reading wears that one face, and the dials are no
   exception — a 24px dial beside a 14px glyph is two rows pretending to be one,
   which is exactly what it looked like.

   The mark is **inside** the pill, not beside it. Kept beside, the two were a
   glyph that happened to have words after it and the eye had to join them; in
   the pill they are one chip, which is the shape the app's own counts already
   wear (`ChipBadge`). `ReadingFace` is the one place that split is decided, so
   no call site spells it and none can draw the two dresses at once. */

/** How big a reading's mark is — the dial in `Ring` or a lucide glyph. */
export const READING_MARK = "size-4"

/** The button geometry, minus the mark's own colour. */
export const READING_TRIGGER =
  "relative shrink-0 rounded-pill @panel-sm:w-auto! @panel-sm:gap-1 @panel-sm:px-1.5"

/**
 * The trigger geometry for a reading whose words are never dropped.
 *
 * `size="icon-xs"` is a 24px *square*, which is right for a bare mark and wrong
 * the moment a pill is inside it: `always` keeps the pill on every width, so
 * the square would leave the words hanging out of the button — over the reading
 * beside it. `w-auto` takes the width off the control so it sizes to its
 * contents; the height stays the row's 24px, so the cluster is still one row.
 * `max-w` is the caller's, since only it knows how long its own value may run.
 */
export const READING_TRIGGER_ALWAYS = "w-auto! max-w-40 min-w-0 px-1.5"

/**
 * The count that rides the mark on a narrow panel — the badge's other dress.
 *
 * Never both at once: a reading that has room to write its count in words wears
 * the badge and hides this, and one that does not wears this. `min-w` rather
 * than a fixed `size`, so a two-character count (`42`, `9+`) still fits the
 * bubble without pushing the mark off its 24px square.
 *
 * **One dress, no tone.** It used to come in two — the readings that were still
 * running wore `primary` and the settled ones `secondary` — and a cluster of
 * four marks came out with two different counts on it, which read as two
 * meanings where there was only one (a number on a mark). The tone went; every
 * count in the shelf now wears the same chip, and it is **verbatim** the one
 * `ChipBadge` draws a sliver's count in (`composer-strip.tsx`), so a count
 * reads the same wherever the strip draws it — footer bubble or sliver,
 * running or settled. What is local here is only *where* it sits (pinned to
 * the mark's top-end corner) and that it hides itself where the words are on
 * screen.
 */
export function ReadingBubble({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <ChipBadge className={cn("absolute -end-0.5 -top-0.5 @panel-sm:hidden", className)}>
      {children}
    </ChipBadge>
  )
}

/**
 * The words a reading grows, in a pill that *carries the mark*.
 *
 * The icon goes inside the badge rather than beside it. A mark floating next to
 * a label is two things sharing a button — it reads as a glyph that happens to
 * have words after it, and the pair is what the eye has to join. A pill holding
 * both is one reading, and it is the shape the app's own chips already have
 * (`ChipBadge`, the `Badge` primitive), so a cluster of readings scans as a row
 * of chips. Small on purpose (10px — under the button's own `text-sm`), on the
 * same ring those two sit on. No ground of its own: the strip draws its items
 * bare, and the button's hover is the only frame a reading wears.
 *
 * It carries the panel breakpoint itself (`hidden @panel-sm:inline-flex`), so a
 * reading never has to remember when it may speak — it asks for the badge and
 * the width decides. Where the pill is not drawn, the caller draws the mark
 * alone: that is `ReadingFace`'s job, and it is why this takes `icon` rather
 * than expecting it as a sibling.
 */
export function ReadingBadge({
  children,
  icon,
  always = false,
  className,
}: {
  children: React.ReactNode
  /** The mark, drawn inside the pill at the same `READING_MARK` size it wears
      bare — one mark, one size, whichever dress it is in. */
  icon?: React.ReactNode
  /** Keep the words on a narrow panel too. For a label that is never dropped —
      `always` reads as the same badge, it only changes when it is drawn. */
  always?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        /* The pair is one flex *row* in both dresses. It used to go `inline` on
           a wide panel, and Tailwind's own preflight makes an `svg` a block —
           so the mark and the words stacked, which is the one thing a chip must
           never do. `inline-flex` throughout: the panel width decides *whether*
           the pill is drawn, never how it lays out.

           Tall enough for the mark rather than for the type: the icon is
           `READING_MARK` (16px) in both dresses, so the pill clears it
           (`h-5` + `py-0`) instead of shrinking it to fit a 10px line. One mark,
           one size, so the reading does not change weight when the panel does.

           `max-w-full` so the pill can never be wider than the button it is in
           — the words ellipsis instead, which is what the truncating span below
           is for. */
        "inline-flex h-5 max-w-full min-w-0 items-center gap-1 px-0.5 text-[10px] leading-none font-medium whitespace-nowrap",
        !always && "hidden @panel-sm:inline-flex",
        className
      )}
    >
      {icon}
      {/* The label is its own flex item so that *it* is what truncates: a caller
          with a name that can run long (the project's `max-w-40`) gets the
          ellipsis on the words, never on the pill's own padding. */}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

/**
 * The face of a reading: the mark alone where the panel is narrow, the mark
 * inside the pill with its words where there is room.
 *
 * One component for the split, so the two dresses can never be drawn together
 * (two marks in one button) or missed together (a reading with no face at all),
 * and so eight call sites do not each spell the same breakpoint. `after` is the
 * trailing dress a count wears on a narrow panel (`ReadingBubble`, which hides
 * itself wherever the words are on screen), so a reading's whole face is one
 * line at its call site.
 */
export function ReadingFace({
  icon,
  label,
  labelClass,
  always = false,
  after,
}: {
  icon: React.ReactNode
  label: React.ReactNode
  /** Extra classes on the pill. */
  labelClass?: string
  /** The badge's own `always` — and it takes the bare mark with it, because the
      pill that keeps the words already keeps the icon. */
  always?: boolean
  after?: React.ReactNode
}) {
  return (
    <>
      {/* `inline-flex` and not a bare span: the mark is a direct flex child of
          the button in the pill dress, and a plain span around it would put an
          inline SVG on a text baseline — a descender's worth of space under the
          glyph, enough to sit the mark a hair off the pill's centreline. */}
      {!always && (
        <span className="@panel-sm:hidden inline-flex items-center justify-center">{icon}</span>
      )}
      <ReadingBadge icon={icon} always={always} className={labelClass}>
        {label}
      </ReadingBadge>
      {after}
    </>
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
  labelClass,
  labelAlways = false,
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
  /** Extra classes on the label pill (a `max-w`, say), merged over its own. */
  labelClass?: string
  /** Keep the words on a narrow panel too — the one reading whose colour *is*
      the news cannot go quiet, and this is the same `always` `ReadingFace`
      gives it, so the mark rides inside the pill there as well. */
  labelAlways?: boolean
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
               `size-6` sets width too and the two are one property apart. A
               reading that keeps its words on every width needs that width on
               every width, so it takes the always-geometry instead. */
            className={cn(
              READING_TRIGGER,
              labelAlways && READING_TRIGGER_ALWAYS,
              "text-muted-foreground hover:text-foreground",
              tone
            )}
            title={title ?? label}
            aria-label={title ?? label}
          >
            <ReadingFace
              icon={icon}
              label={label}
              labelClass={labelClass}
              always={labelAlways}
            />
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

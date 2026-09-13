/* ── The alert ──
   One box for every message the app draws *about* something rather than as the
   thing itself: a connection that dropped, a command that could not be read, a
   backup exported without credentials, a quota nearly spent, a routine that
   needs a person. The rule is about what the box is, not where it sits — a page,
   a dialog, a settings form and the strip above the composer draw the same four
   tones at the same two densities, so a warning reads as one wherever it lands.

   Before this there were three `Banner`s, a `Note`, a `WarningLine` and half a
   dozen bespoke `<p>`s, each with its own border weight, radius, wash and icon
   size. The one that started this — "This thread's agent isn't running" — was a
   centered dashed rule while the failure directly above it in the same stack was
   a solid amber box: two answers to one question.

   Tone is semantic, not a colour: `error` is the app's destructive, `warn` its
   amber, `info` its sky, `neutral` the muted ground a notice that is only
   explaining something wears. The glyph follows the tone unless a caller names
   its own (`icon={false}` for a box that reads better bare). A `title` is the
   one bold line saying what the box is about; the children are the body and any
   controls; `action` is a control anchored to the end, against the first line.
   Role is derived too (`alert` for the two tones that are news, `status` for the
   rest) so nothing has to remember to say it. */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { InfoIcon, TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const noticeVariants = cva("flex items-start rounded-lg border", {
  variants: {
    tone: {
      neutral: "border-border/60 bg-muted/40 text-muted-foreground",
      info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      error: "border-destructive/30 bg-destructive/5 text-destructive",
    },
    size: {
      sm: "gap-2 px-3 py-2 text-xs",
      md: "gap-2 px-3 py-2 text-sm",
    },
  },
  defaultVariants: {
    tone: "neutral",
    size: "sm",
  },
})

/** The glyph a tone wears when the caller does not name one. */
const TONE_ICON = {
  neutral: InfoIcon,
  info: InfoIcon,
  warn: TriangleAlertIcon,
  error: TriangleAlertIcon,
} as const

export interface NoticeProps
  extends Omit<React.ComponentProps<"div">, "title">,
    VariantProps<typeof noticeVariants> {
  /** Glyph at the head. Defaults from the tone; `false` for a box with none. */
  icon?: React.ReactNode | false
  /** The one bold line saying what the box is about, above the body. */
  title?: React.ReactNode
  /** A control anchored to the end, against the first line. */
  action?: React.ReactNode
}

export function Notice({
  tone = "neutral",
  size = "sm",
  icon,
  title,
  action,
  className,
  children,
  ...props
}: NoticeProps) {
  const Icon = TONE_ICON[tone ?? "neutral"]
  const glyph = icon === false ? null : (icon ?? <Icon />)
  return (
    <div
      role={tone === "warn" || tone === "error" ? "alert" : "status"}
      className={cn(noticeVariants({ tone, size }), className)}
      {...props}
    >
      {glyph && (
        <span
          className={cn(
            "shrink-0 leading-none",
            size === "md" ? "mt-0.5 [&>svg]:size-4" : "mt-px [&>svg]:size-3.5"
          )}
        >
          {glyph}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium text-pretty">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

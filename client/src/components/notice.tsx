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

   It is the registry's `Alert`, dressed by tone and nothing else: `error` is
   the destructive variant, `warn` the default box in `--warning`, `info` the
   default box as shipped, `neutral` the default box in muted text for a notice
   that is only explaining something. The glyph follows the tone unless a caller names
   its own (`icon={false}` for a box that reads better bare). A `title` is the
   one bold line saying what the box is about; the children are the body and any
   controls; `action` is a control anchored to the end, against the first line
   (an error's Copy, by default). A Notice carries no margin of its own: on a
   page it is a `Section`'s child, in a card the card's spacing places it.
   Role is derived too (`alert` for the two tones that are news, `status` for the
   rest) so nothing has to remember to say it. */
import * as React from "react"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { CopyButton } from "@/components/ui/copy-button"
import { cn } from "@/lib/utils"

type Tone = "neutral" | "info" | "success" | "warn" | "error"

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  info: "",
  success: "text-success",
  warn: "text-warning",
  error: "",
}

/** The glyph a tone wears when the caller does not name one. */
const TONE_ICON = {
  neutral: InfoIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warn: TriangleAlertIcon,
  error: TriangleAlertIcon,
} as const

export interface NoticeProps extends Omit<React.ComponentProps<"div">, "title"> {
  tone?: Tone | null
  /** `sm` inside a form, a strip or a list; `md` the stock alert's padding. */
  size?: "sm" | "md" | null
  /** Glyph at the head. Defaults from the tone; `false` for a box with none. */
  icon?: React.ReactNode | false
  /** The one bold line saying what the box is about, above the body. */
  title?: React.ReactNode
  /** A control anchored to the end, against the first line. */
  action?: React.ReactNode
  /** The text a Copy button at the end copies. An `error` whose body is a
      plain string gets one for that string without asking. Ignored when an
      `action` is given. */
  copy?: string
}

export function Notice({
  tone = "neutral",
  size = "sm",
  icon,
  title,
  action,
  copy,
  className,
  children,
  ...props
}: NoticeProps) {
  const t = tone ?? "neutral"
  const copyText = copy ?? (t === "error" && typeof children === "string" ? children : undefined)
  const end = action ?? (copyText ? <CopyButton text={copyText} size="icon-xs" /> : null)
  const Icon = TONE_ICON[t]
  const glyph = icon === false ? null : (icon ?? <Icon />)
  return (
    <Alert
      variant={t === "error" ? "destructive" : "default"}
      role={t === "warn" || t === "error" ? "alert" : "status"}
      dir="auto"
      className={cn(
        "flex items-start gap-2.5",
        size === "md" ? "px-4 py-3" : "px-3 py-2",
        TONE_CLASS[t],
        className
      )}
      {...props}
    >
      {glyph && <span className="mt-0.5 shrink-0 leading-none [&>svg]:size-4">{glyph}</span>}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium text-pretty">{title}</p>}
        {children}
      </div>
      {end && <div className="shrink-0 self-center">{end}</div>}
    </Alert>
  )
}

/* ── Inline error ──
   A failure drawn where it happened, rather than raised as a toast.

   The rule is about attention, not about severity. A toast is bottom-trailing
   and transient, which is right for something that failed *around* the user —
   a copied link, a background refresh. It is wrong for a failure inside a
   surface the user is looking at: a dialog covers the toast's corner, the
   modal's own controls give no sign anything went wrong, and a scan that
   answered nothing looks exactly like a scan that never reached the server.
   So the surfaces that hold their own failures — every dialog, every settings
   form — draw one of these instead, next to the control that caused it.

   The value comes from `captureError` (lib/errors.ts), which already did the
   normalizing, the console logging and the "don't let the global net say this
   twice" bookkeeping. This component only draws. */
import * as React from "react"
import { AlertTriangleIcon, CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { InlineError } from "@/lib/errors"
import { cn } from "@/lib/utils"

export function ErrorNote({
  error,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  /** Null draws nothing, so a call site can render it unconditionally. */
  error: InlineError | null
  onRetry?: () => void
  retryLabel?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  /* A second failure is a second thing to read: collapse again so a long
     detail from the last one cannot be mistaken for this one's. */
  React.useEffect(() => {
    setExpanded(false)
    setCopied(false)
  }, [error])

  if (!error) return null

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(error.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard is permission-gated; the text is on screen either way. */
    }
  }

  // The headline is the action that failed; the normalized title only repeats
  // it when there is no context, so it moves into the body when there is one.
  const body = [error.context ? error.title : undefined, error.detail]
    .filter(Boolean)
    .join("\n\n")
  /* Offered only when the clamp can actually be hiding something — a one-line
     "unknown profile (404)" with a More button under it is a promise of a
     detail that does not exist. */
  const long = body.length > 160 || body.split("\n").length > 3

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive",
        className
      )}
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-pretty">{error.context ?? error.title}</p>
        {body && (
          /* Paths, commands and server bodies: one long unspaced token has to
             break rather than push the dialog wide, and the newlines the agent
             or the server wrote are part of the message. */
          <p
            className={cn(
              "text-xs whitespace-pre-wrap text-destructive/85 [overflow-wrap:anywhere]",
              !expanded && "line-clamp-3"
            )}
          >
            {body}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs hover:bg-destructive/10"
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          )}
          {long && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs hover:bg-destructive/10"
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Less" : "More"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs hover:bg-destructive/10"
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </div>
  )
}

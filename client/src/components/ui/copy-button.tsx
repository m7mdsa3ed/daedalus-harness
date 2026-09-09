/* ── Copy, with its own confirmation ──
   Every surface that draws a failure offers one of these, so the text a user
   needs to paste into an issue or hand to another agent is one click away and
   never a mouse-drag across a clamped `line-clamp-3` paragraph.

   The check IS the feedback — no toast, unlike `copyText` (step-row.tsx).
   These live *inside* the thing that failed: an error card, a held turn, a
   failed tool's output. A success toast raised from there competes with the
   failure being read, and on a dialog it lands behind the modal anyway. */
import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { writeClipboard } from "@/lib/clipboard"

export function CopyButton({
  text,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  text: string
  /** Given, the button wears a word; omitted, it is the icon alone and the
      word moves to `aria-label`. */
  label?: string
}) {
  const [copied, setCopied] = React.useState(false)

  /* A second failure is a second thing to copy: the tick must not still be up
     from the last one. `text` is a string by contract, never a getter, so this
     compares by value rather than resetting on every render. */
  React.useEffect(() => setCopied(false), [text])

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={copied ? "Copied" : (label ?? "Copy")}
      {...props}
      onClick={() => {
        void writeClipboard(text)
          .then(() => setCopied(true))
          /* Clipboard is permission-gated and unavailable over plain http on
             some browsers. The text is on screen either way, so a failure to
             copy is not a failure worth a card of its own. */
          .catch(() => {})
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label ? (copied ? "Copied" : label) : null}
    </Button>
  )
}

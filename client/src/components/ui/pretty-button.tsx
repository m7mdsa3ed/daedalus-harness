/* ── Pretty-print toggle for a code block ──
   One button and one hook for every place a fenced block is drawn (a message's
   fence, a tool call's code pane), so the affordance cannot differ between
   them. Formatting is a *view*: the original text is never replaced, and the
   same button puts it back. A block whose language Prettier cannot lay out
   (`canPrettify`) draws nothing at all. */
import * as React from "react"
import { LoaderCircleIcon, Undo2Icon, WandSparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCoarsePointer } from "@/hooks/use-device"
import { canPrettify, prettify } from "@/lib/pretty"
import { cn } from "@/lib/utils"

interface Pretty {
  /** The laid-out text while the toggle is on, else null (show the original). */
  text: string | null
  busy: boolean
  /** First line of why the last attempt failed; clears itself. */
  error: string | null
  toggle: (source: string) => void
}

/** `auto` is the text to lay out as soon as the block mounts (and again if it
    changes) — a default, not a lock: toggling back to the original sticks. */
export function usePretty(language: string | undefined, auto?: string): Pretty {
  const [text, setText] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [declined, setDeclined] = React.useState(false)
  /* A late answer for a block that has since been reverted, or re-asked, must
     not win: only the newest request may write. */
  const request = React.useRef(0)

  React.useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(timer)
  }, [error])

  const run = React.useCallback(
    (source: string, lang: string) => {
      const id = ++request.current
      setBusy(true)
      setError(null)
      prettify(source, lang).then(
        (out) => {
          if (id !== request.current) return
          setBusy(false)
          setText(out)
        },
        (err: unknown) => {
          if (id !== request.current) return
          setBusy(false)
          const message = err instanceof Error ? err.message : String(err)
          setError(message.split("\n")[0] || "Could not format")
        }
      )
    },
    []
  )

  /* The default. A different payload is a different block, so it starts over
     from the original until its own layout lands. */
  React.useEffect(() => {
    setText(null)
    if (auto === undefined || !language || !canPrettify(language) || declined) return
    run(auto, language)
    return () => {
      request.current++
    }
  }, [auto, language, declined, run])

  const toggle = React.useCallback(
    (source: string) => {
      if (text !== null) {
        request.current++
        setText(null)
        setBusy(false)
        setDeclined(true)
        return
      }
      if (!language) return
      setDeclined(false)
      run(source, language)
    },
    [text, language, run]
  )

  return { text, busy, error, toggle }
}

export function PrettyButton({
  language,
  pretty,
  source,
  className,
}: {
  language: string | undefined
  pretty: Pretty
  /** The original text, read at click time. */
  source: () => string
  className?: string
}) {
  const coarse = useCoarsePointer()
  if (!canPrettify(language)) return null
  const on = pretty.text !== null
  const label = on ? "Show original" : pretty.error ? `Cannot format: ${pretty.error}` : "Pretty print"
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-xs"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={pretty.busy}
      onClick={() => pretty.toggle(source())}
      className={cn(
        "absolute top-1 bg-popover",
        pretty.error && "text-destructive",
        coarse || on || pretty.error
          ? "opacity-100"
          : "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100",
        className
      )}
    >
      {pretty.busy ? <LoaderCircleIcon className="animate-spin" /> : on ? <Undo2Icon /> : <WandSparklesIcon />}
    </Button>
  )
}

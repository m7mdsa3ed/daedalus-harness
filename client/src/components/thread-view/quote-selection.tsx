/* ── Quote a selection ──
   Select text anywhere in the transcript and a small "Ask about this" rides
   the selection; pressing it puts the excerpt in the composer as a `> ` quote
   under whatever is already typed, caret on the line after it. Nothing is sent
   — the words the question needs are the reader's to add.

   Scoped by `.thread-transcript` inside the caller's root rather than a ref,
   so a selection in the composer, the inspector or another panel's transcript
   never offers it. Fixed-positioned off the range's own rect: it stays with
   the text through a scroll, and it is the selection's until the selection
   goes. On a touch device it sits *below* the text, because above is where the
   OS draws its own copy/select-all bar. */
import * as React from "react"
import { createPortal } from "react-dom"
import { MessageSquareQuoteIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCoarsePointer } from "@/hooks/use-device"

interface Anchor {
  text: string
  top: number
  bottom: number
  left: number
}

function readSelection(root: HTMLElement): Anchor | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const within = (node: Node | null) => {
    const el = node instanceof Element ? node : node?.parentElement
    const transcript = el?.closest(".thread-transcript")
    return !!transcript && root.contains(transcript)
  }
  if (!within(range.startContainer) || !within(range.endContainer)) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { text, top: rect.top, bottom: rect.bottom, left: rect.left + rect.width / 2 }
}

export function QuoteSelection({
  rootRef,
  onQuote,
}: {
  rootRef: React.RefObject<HTMLElement | null>
  onQuote: (text: string) => void
}) {
  const [anchor, setAnchor] = React.useState<Anchor | null>(null)
  const coarse = useCoarsePointer()

  React.useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const root = rootRef.current
        setAnchor(root ? readSelection(root) : null)
      })
    }
    document.addEventListener("selectionchange", update)
    // Capture: the transcript's scroller is not the window.
    window.addEventListener("scroll", update, true)
    window.addEventListener("resize", update)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("selectionchange", update)
      window.removeEventListener("scroll", update, true)
      window.removeEventListener("resize", update)
    }
  }, [rootRef])

  if (!anchor) return null
  const below = coarse
  return createPortal(
    <div
      className="fixed z-50 animate-in fade-in-0 zoom-in-95"
      style={{
        left: anchor.left,
        top: below ? anchor.bottom + 8 : anchor.top - 8,
        translate: below ? "-50% 0" : "-50% -100%",
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 bg-popover px-2 text-xs shadow-md"
        // Keep the selection: a mousedown on a button would collapse it first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onQuote(anchor.text)
          window.getSelection()?.removeAllRanges()
          setAnchor(null)
        }}
      >
        <MessageSquareQuoteIcon aria-hidden className="size-3.5" />
        Ask about this
      </Button>
    </div>,
    document.body
  )
}

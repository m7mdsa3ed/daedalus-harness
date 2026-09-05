import { keyboardState, subscribeKeyboard } from "./keyboard-inset"

/* ── Keeping the field you are typing in visible ──
   `keyboard-inset.ts` moves the surfaces the harness owns — the composer, a
   dialog, a sheet, a flyout. This is the other half: an ordinary field on an
   ordinary scrolling page (a settings form, a task's fields, a long panel).

   The browser used to do this. It stopped when index.html asked for
   `interactive-widget=overlays-content`: the scroll-into-view a browser
   performs on focus is driven by the visual viewport shrinking, and under
   `overlays-content` it deliberately does not shrink. The trade is the point of
   that flag — a transcript that jumps half a screen has lost the reader's place
   — but it leaves a field near the bottom of a form drawn underneath the keys
   with nothing to scroll it back. So the scroll is done by hand, once, and only
   when the field is actually covered.

   Two things it deliberately does not do:

   - It does not fight the surfaces that ride the keyboard. It measures *after*
     the ride (`SETTLE_MS` > the 285ms those transitions take), so a composer or
     a dialog that has already moved out of the way reports no overlap and
     nothing scrolls.
   - It does not scroll the page under a field that is merely close to the
     keyboard. Only the overlap is scrolled, plus a line of margin, so the
     reader keeps as much context as the keyboard left. */

/** Room to leave under the field, so its focus ring is not flush with the keys. */
const MARGIN_PX = 16

/* Long enough for a surface that rides the keyboard (285ms) to have arrived,
   so the measurement below is of where things ended up. */
const SETTLE_MS = 320

function isTextEntry(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  if (node.isContentEditable) return true
  const tag = node.tagName
  if (tag === "TEXTAREA") return true
  // A button-like input opens no keyboard; only the ones that take a caret.
  return tag === "INPUT" && !/^(button|checkbox|color|file|image|radio|range|reset|submit)$/i.test(
    (node as HTMLInputElement).type
  )
}

/** The nearest ancestor that can actually be scrolled down. */
function scrollableAncestor(from: HTMLElement): Element | null {
  let node: Element | null = from.parentElement
  while (node) {
    const overflow = getComputedStyle(node).overflowY
    const scrolls = overflow === "auto" || overflow === "scroll" || overflow === "overlay"
    if (scrolls && node.scrollHeight - node.clientHeight > 1) return node
    node = node.parentElement
  }
  // The document itself, when it is the thing with the scrollbar.
  const root = document.scrollingElement
  return root && root.scrollHeight - root.clientHeight > 1 ? root : null
}

function reveal() {
  const { height } = keyboardState()
  if (height === 0) return
  const field = document.activeElement
  if (!isTextEntry(field)) return

  const covered = field.getBoundingClientRect().bottom - (window.innerHeight - height)
  const overlap = covered + MARGIN_PX
  if (overlap <= 0) return

  const scroller = scrollableAncestor(field)
  if (!scroller) return
  scroller.scrollBy({ top: overlap, behavior: "smooth" })
}

/** Keep the focused field above the soft keyboard until the returned function is called. */
export function startCaretKeeper(): () => void {
  let timer: number | undefined
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = window.setTimeout(reveal, SETTLE_MS)
  }

  // Both doors: the keyboard opening under a field already focused, and focus
  // moving to the next field while it is open.
  const stop = subscribeKeyboard(schedule)
  document.addEventListener("focusin", schedule)
  return () => {
    if (timer) clearTimeout(timer)
    stop()
    document.removeEventListener("focusin", schedule)
  }
}

/* ── The soft keyboard, as a CSS variable ──
   `--keyboard-inset` on the document root: how much of the viewport the
   on-screen keyboard is covering, in pixels, 0 when it is closed.

   The page does not resize when a keyboard opens — index.html asks for
   `interactive-widget=overlays-content` and this module asks the same of the
   VirtualKeyboard API — because a transcript that jumps half a screen on focus
   has lost the reader's place. The keyboard is drawn over the bottom instead,
   which leaves whatever is anchored there underneath it. Nothing scrolls it
   back into view either: the docked composer is `position: absolute` against a
   panel that does not scroll, so the browser has nothing to scroll. So the one
   surface that must move is moved by hand, from this number.

   Measuring it takes two paths, because the two ways a browser can be asked to
   overlay contradict each other:

   - Chromium has `navigator.virtualKeyboard`. Setting `overlaysContent` there
     is what makes the keyboard an overlay *and* what makes its geometry
     readable: `boundingRect` is the keyboard, `geometrychange` fires as it
     slides. This is the path on Android, and it is the whole reason this file
     is not four lines of `visualViewport` arithmetic — under `overlays-content`
     the visual viewport is deliberately NOT resized, so the obvious
     `innerHeight - visualViewport.height` is always 0 and the composer never
     moves.
   - Everywhere else (iOS Safari, which ignores `interactive-widget`) the
     keyboard still shrinks the visual viewport, so that subtraction is the
     answer. Reads are coalesced into a frame — `resize` and `scroll` both fire
     per animation frame while the keyboard slides.

   Both are installed: whichever reports the larger number wins, so a browser
   that grows support for one of them cannot end up reading zero from the
   other. */
export const KEYBOARD_INSET = "--keyboard-inset"

/* Below this, it is not a keyboard: a retracting URL bar and sub-pixel
   rounding both move the visual viewport by a few px, and reacting to those
   would twitch the composer on every scroll. */
const MIN_KEYBOARD_PX = 48

type VirtualKeyboard = EventTarget & {
  overlaysContent: boolean
  boundingRect: DOMRectReadOnly
}

function virtualKeyboard(): VirtualKeyboard | null {
  const candidate = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard })
    .virtualKeyboard
  return candidate && "boundingRect" in candidate ? candidate : null
}

/** Publish `--keyboard-inset` until the returned function is called. */
export function startKeyboardInset(): () => void {
  const root = document.documentElement
  const viewport = window.visualViewport
  const keyboard = virtualKeyboard()

  if (keyboard) {
    // Asking for the overlay is also what turns the geometry on. Guarded: a
    // browser may expose the object and refuse the setter.
    try {
      keyboard.overlaysContent = true
    } catch {
      // Then `boundingRect` stays empty and the viewport path below answers.
    }
  }
  if (!keyboard && !viewport) {
    root.style.setProperty(KEYBOARD_INSET, "0px")
    return () => root.style.removeProperty(KEYBOARD_INSET)
  }

  let frame = 0
  let last = -1
  const publish = () => {
    frame = 0
    // The keyboard's own height where it is readable, and what the visual
    // viewport has lost where it is not. Neither is negative and only one is
    // ever non-zero, so the larger is the answer under either regime.
    const fromKeyboard = keyboard ? keyboard.boundingRect.height : 0
    const fromViewport = viewport
      ? window.innerHeight - (viewport.height + viewport.offsetTop)
      : 0
    const covered = Math.max(fromKeyboard, fromViewport)
    const inset = covered > MIN_KEYBOARD_PX ? Math.round(covered) : 0
    if (inset === last) return
    last = inset
    root.style.setProperty(KEYBOARD_INSET, `${inset}px`)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(publish)
  }

  publish()
  keyboard?.addEventListener("geometrychange", schedule)
  viewport?.addEventListener("resize", schedule)
  viewport?.addEventListener("scroll", schedule)
  return () => {
    if (frame) cancelAnimationFrame(frame)
    keyboard?.removeEventListener("geometrychange", schedule)
    viewport?.removeEventListener("resize", schedule)
    viewport?.removeEventListener("scroll", schedule)
    root.style.removeProperty(KEYBOARD_INSET)
  }
}

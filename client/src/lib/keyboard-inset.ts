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

/* ── Riding it ──
   Every surface that must clear the keyboard is `position: fixed`, or absolute
   against something that does not scroll, so the browser's own scroll-into-view
   has nothing to move and each one is moved by hand from the number above.
   These are the three ways to do it, named once so a new surface copies a name
   and not a calc:

   - `KEYBOARD_LIFT` for a surface whose *reserved height* must not move with it
     (the composer: the transcript pads by `--composer-dock-h`, measured from
     offsetHeight, and a `bottom` change would drag that with it). A transform,
     so it stays on the compositor and changes no layout.
   - `KEYBOARD_CENTER` for a centred popup, which stays centred in what is left
     above the keyboard rather than in a viewport a third of which is covered.
   - `KEYBOARD_RISE` for a bottom-anchored surface that owns its own box (a
     sheet, a drawer): moving its `bottom` also moves the edge its height is
     capped against, which is what a sheet wants — so it is a `bottom` and not a
     transform, and the surface must name `bottom` in its own transition.

   Only `KEYBOARD_LIFT` carries a duration, because the composer has no other:
   the two that ride an existing surface inherit that surface's transition, and
   a duration here would be a `duration-*` fight decided by class order. Its
   285ms on cubic-bezier(0.2, 0, 0, 1) is Android's own IME animation
   (ANIMATION_DURATION_SYNC_IME_MS and SYNC_IME_INTERPOLATOR, AOSP
   `InsetsController`), copied because it cannot be followed — see
   thread-view.tsx for why the per-frame position never reaches the renderer.

   All three are `cn`'d *after* the surface's own classes: each one overrides a
   `translate-y-*` or `bottom-*` the surface already sets. */

/** Move a surface up by the keyboard's height without changing its layout. */
export const KEYBOARD_LIFT =
  "translate-y-[calc(var(--keyboard-inset,0px)*-1)] transition-[translate] duration-[285ms] ease-[cubic-bezier(0.2,0,0,1)] will-change-transform motion-reduce:transition-none"

/** Keep a centred surface centred in what is left above the keyboard. */
export const KEYBOARD_CENTER =
  "translate-y-[calc(-50%-var(--keyboard-inset,0px)/2)] transition-[translate] motion-reduce:transition-none"

/** Lift a bottom-anchored surface, and the edge its height is capped against. */
export const KEYBOARD_RISE = "bottom-[var(--keyboard-inset,0px)]"

/* ── Reading it from script ──
   The variable is the answer for anything CSS can place. Two things it cannot:
   a Base UI positioner, which collides against a rect it computes in JS, and
   anything that needs to know *which* of the two measurements answered.

   That second question is the whole reason this is a store and not a
   `getComputedStyle` call. Under the visual-viewport regime (iOS) the viewport
   floating-ui measures against has *already* shrunk, so it collides above the
   keyboard on its own and padding by the same number again would push a
   flyout up by twice the keyboard. Under `overlaysContent` (Android) the
   viewport deliberately does not shrink, floating-ui sees the full page, and
   the padding is the only thing that keeps a dropdown off the keyboard. So the
   padding is the inset in one regime and 0 in the other. */
export type KeyboardState = {
  /** Pixels of the layout viewport the keyboard covers; 0 when closed. */
  height: number
  /** Whether the visual viewport has already lost that height. */
  shrinksViewport: boolean
}

const CLOSED: KeyboardState = { height: 0, shrinksViewport: false }

let state: KeyboardState = CLOSED
const listeners = new Set<() => void>()

/** The current keyboard. A stable object between changes: `useSyncExternalStore`. */
export function keyboardState(): KeyboardState {
  return state
}

export function subscribeKeyboard(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setState(next: KeyboardState) {
  if (next.height === state.height && next.shrinksViewport === state.shrinksViewport) return
  state = next
  for (const listener of listeners) listener()
}

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
    setState(CLOSED)
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
    // Which path answered, for the readers that must not double-count it.
    setState(
      inset === 0
        ? CLOSED
        : { height: inset, shrinksViewport: fromViewport >= fromKeyboard }
    )
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
    setState(CLOSED)
  }
}

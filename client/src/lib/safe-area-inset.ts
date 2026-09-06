/* ── The device safe-area insets, as numbers ──
   `env(safe-area-inset-*)` is CSS-only: it cannot be read from script and it
   cannot be read by anything that positions in JS. The shell pads itself in CSS
   (`--app-inset-top`, the sidebar, the composer), but a portaled flyout is
   placed by floating-ui against a rect it computes in numbers — so without this
   module a dropdown anchored near the top lands under the status bar and one
   near an edge under the notch, because the shell's padding is invisible to it.

   Measuring takes the probe trick: an invisible fixed element whose padding is
   the four env() values; `getComputedStyle` then answers in used pixels. The
   insets move with rotation and with the browser chrome appearing and leaving,
   so the read is re-run, coalesced into a frame, on the same events the
   keyboard store rides. */
export type SafeAreaInsets = {
  top: number
  right: number
  bottom: number
  left: number
}

const ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 }

let state: SafeAreaInsets = ZERO
const listeners = new Set<() => void>()

/** The current insets in px, rounded. A stable object between changes: `useSyncExternalStore`. */
export function safeAreaState(): SafeAreaInsets {
  return state
}

export function subscribeSafeArea(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setState(next: SafeAreaInsets) {
  if (
    next.top === state.top &&
    next.right === state.right &&
    next.bottom === state.bottom &&
    next.left === state.left
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

/** Publish the measured insets until the returned function is called. */
export function startSafeAreaInset(): () => void {
  const probe = document.createElement("div")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px)" +
    " env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)"
  document.body.appendChild(probe)

  const read = () => {
    const style = getComputedStyle(probe)
    setState({
      top: Math.max(0, Math.round(parseFloat(style.paddingTop))),
      right: Math.max(0, Math.round(parseFloat(style.paddingRight))),
      bottom: Math.max(0, Math.round(parseFloat(style.paddingBottom))),
      left: Math.max(0, Math.round(parseFloat(style.paddingLeft))),
    })
  }
  let frame = 0
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      read()
    })
  }

  read()
  window.addEventListener("resize", schedule)
  window.addEventListener("orientationchange", schedule)
  window.visualViewport?.addEventListener("resize", schedule)
  return () => {
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener("resize", schedule)
    window.removeEventListener("orientationchange", schedule)
    window.visualViewport?.removeEventListener("resize", schedule)
    probe.remove()
    setState(ZERO)
  }
}

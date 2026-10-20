import * as React from "react"
import { Popover, PopoverContent } from "@/components/ui/popover"

/**
 * Every native `title` in the app drawn as the app's own tooltip, from one
 * listener rather than a wrapper per call site: a `title` is a DOM fact, so
 * the ones dockview and xterm write are caught too, and `title="…"` stays the
 * one way to label a control. The attribute is lifted on the pointer's arrival
 * — before the browser's own delay — into `data-title`, and what it named for
 * a screen reader moves to `aria-label` (no text of its own) or
 * `aria-description` (it has text, so the title was the extra). React only
 * writes an attribute that changed, so a lifted one stays lifted until its
 * value does, and then is lifted again.
 */
const DELAY = 500
// Moving from one titled control to the next shows at once, like a toolbar.
const WARM = 300

function lift(el: Element): string | null {
  const title = el.getAttribute("title")
  if (title) {
    el.removeAttribute("title")
    el.setAttribute("data-title", title)
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
      el.setAttribute(el.textContent?.trim() ? "aria-description" : "aria-label", title)
    }
  }
  return el.getAttribute("data-title") || null
}

export function TitleTooltips() {
  const [tip, setTip] = React.useState<{ el: Element; text: string } | null>(null)

  React.useEffect(() => {
    let timer = 0
    let current: Element | null = null
    let closedAt = 0

    const hide = () => {
      window.clearTimeout(timer)
      if (current) closedAt = Date.now()
      current = null
      setTip(null)
    }
    const arm = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest("[title],[data-title]") : null
      if (el === current) return
      const text = el ? lift(el) : null
      window.clearTimeout(timer)
      if (!el || !text) return hide()
      if (current) closedAt = Date.now()
      current = el
      setTip(null)
      const show = () => current === el && el.isConnected && setTip({ el, text: lift(el) ?? text })
      if (Date.now() - closedAt < WARM) show()
      else timer = window.setTimeout(show, DELAY)
    }

    const over = (e: PointerEvent) => (e.pointerType === "mouse" ? arm(e.target) : hide())
    /* Only what concerns the tip dismisses it. A stationary pointer fires no new
       `pointerover`, so a tip dropped by an unrelated event — a streaming
       transcript scrolling, focus moving in the composer — was never drawn
       again until the pointer left and came back: "hover works some of the time". */
    const hideIfAbout = (e: Event) => {
      const target = e.target
      if (!current || !(target instanceof Node)) return hide()
      if (target.contains(current) || current.contains(target)) hide()
    }
    const focus = (e: FocusEvent) => {
      const t = e.target
      if (t instanceof Element && t.matches(":focus-visible")) arm(t)
    }
    // An SVG `<title>` child is not the attribute and is left alone.
    document.addEventListener("pointerover", over, true)
    document.addEventListener("focusin", focus, true)
    document.addEventListener("focusout", hideIfAbout, true)
    document.addEventListener("pointerdown", hide, true)
    document.addEventListener("keydown", hide, true)
    document.addEventListener("scroll", hideIfAbout, true)
    document.documentElement.addEventListener("pointerleave", hide)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("pointerover", over, true)
      document.removeEventListener("focusin", focus, true)
      document.removeEventListener("focusout", hideIfAbout, true)
      document.removeEventListener("pointerdown", hide, true)
      document.removeEventListener("keydown", hide, true)
      document.removeEventListener("scroll", hideIfAbout, true)
      document.documentElement.removeEventListener("pointerleave", hide)
    }
  }, [])

  return (
    <Popover open={!!tip} modal={false}>
      {tip && (
        <PopoverContent
          anchor={tip.el}
          side="bottom"
          sideOffset={6}
          className="pointer-events-none w-fit max-w-[min(24rem,calc(var(--float-w)-1.5rem))] gap-0 px-3 py-1.5 text-xs whitespace-pre-line"
        >
          {tip.text}
        </PopoverContent>
      )}
    </Popover>
  )
}

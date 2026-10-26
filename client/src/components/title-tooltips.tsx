import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"

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
    /* Composed from the primitive rather than `ui/popover` because this tip has
       no trigger: it is anchored to whatever element the pointer found, which
       is the positioner's `anchor` prop. The registry's `PopoverContent` takes
       it from the trigger's context and does not forward it, and this file must
       not depend on the registry file's shape anyway. */
    <PopoverPrimitive.Root open={!!tip} modal={false}>
      {tip && (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner anchor={tip.el} side="bottom" sideOffset={6} className="isolate z-50">
            <PopoverPrimitive.Popup
              data-slot="popover-content"
              className={cn(
                "pointer-events-none z-50 flex w-fit max-w-[min(24rem,calc(var(--float-w)-1.5rem))] origin-(--transform-origin) flex-col gap-0 rounded-2xl bg-popover px-3 py-1.5 text-xs whitespace-pre-line text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              )}
            >
              {tip.text}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  )
}

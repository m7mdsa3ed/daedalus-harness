import * as React from "react"

const MOBILE_BREAKPOINT = 768

/* `--container-panel-sm`, in px. The CSS half of this question is the
   `@panel-sm:` variant; this is for the few places that must choose a whole
   *tree* rather than restyle one, which a container query cannot do. */
const PANEL_SM = 640

/**
 * Is the box this ref sits in narrower than the panel-sm breakpoint?
 *
 * "Mobile" is two questions (docs/client.md): **width is the panel's**, the
 * pointer is the device's. Use this for layout; `useIsMobile` below still
 * answers the window, which is right for touch targets and wrong for layout.
 */
export function useIsNarrow(ref: React.RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = React.useState(false)

  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      /* A dock tab that is not in front measures 0×0 — dockview keeps every
         panel mounted — and answering "narrow" for it would rebuild the tree
         of a list nobody is looking at. The observer fires again on the way
         back in. */
      if (width > 0) setNarrow(width < PANEL_SM)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return narrow
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

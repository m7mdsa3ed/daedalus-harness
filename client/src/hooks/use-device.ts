/* The device questions the app asks — the one home for all of them. Kept OUT
   of `use-mobile.ts`: that file is shadcn's own generated hook, and a
   `shadcn add` of anything that depends on it rewrites it back to the stock
   version — which is exactly how `useCoarsePointer` disappeared and every
   importer became a blank screen. `use-mobile.ts` is now a one-line re-export
   of this file for shadcn's own components (`ui/sidebar.tsx`); a regeneration
   turns it back into a private copy of `useIsMobile` that only `ui/` reads, so
   the app loses nothing. **Import from here, never from `use-mobile`.** */
import * as React from "react"

/* Tailwind's `md`, and the one definition of the width breakpoint. Read it
   only where a width has to be measured outside a media query; `useIsMobile`
   is the answer everywhere else. */
export const MOBILE_BREAKPOINT = 768

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

/* Whether the *device's* primary pointer is a finger. Distinct from
   `useIsMobile`, which is a width: a narrow chat panel on a desktop is still
   driven by a mouse, and a tablet in landscape is wide but still a thumb. The
   composer sizes its touch targets and offers the camera on this answer, and
   decides what Enter means on the other — a soft keyboard is a width question
   in practice (see the Enter handler in composer.tsx). The scroll area swaps
   to native overflow on it too; it used to ask a second, effect-based copy of
   this question (`useTouchPrimary`) that answered one render late. */
const COARSE = "(pointer: coarse)"

function subscribeCoarse(listener: () => void) {
  const mql = window.matchMedia(COARSE)
  mql.addEventListener("change", listener)
  return () => mql.removeEventListener("change", listener)
}

export function useCoarsePointer(): boolean {
  return React.useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE).matches,
    () => false
  )
}

import * as React from "react"

const MOBILE_BREAKPOINT = 768

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
   in practice (see the Enter handler in composer.tsx). */
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

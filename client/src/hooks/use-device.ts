/* The device questions the app asks, kept OUT of `use-mobile.ts`: that file is
   shadcn's own generated hook, and a `shadcn add` of anything that depends on
   it rewrites it back to the stock version — which is exactly how
   `useCoarsePointer` disappeared and every importer became a blank screen.
   Nothing in the app imports `use-mobile` directly; shadcn's own components
   (`ui/sidebar.tsx`) still may, because they regenerate together. */
import * as React from "react"

import { useIsMobile } from "@/hooks/use-mobile"

export { useIsMobile }

/* Kept in sync with the constant inside shadcn's `use-mobile.ts` (and with
   Tailwind's `md`). Read it only where a width has to be measured outside a
   media query; `useIsMobile` is the answer everywhere else. */
export const MOBILE_BREAKPOINT = 768

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

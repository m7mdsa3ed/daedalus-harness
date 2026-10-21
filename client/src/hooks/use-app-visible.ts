/* ── Whether the reader is in front of this window ──
   Two cases, one answer: a hidden tab, and a visible window another app is in
   front of. The same test `lib/notifications.ts` uses to decide a notice is
   worth raising as an OS notification, and it is the right one here too — the
   question "has this been read?" is about eyes, not about whether a browser
   chose to keep painting.

   The `focus`/`blur` pair is what catches the second case: `visibilitychange`
   alone fires only when the tab is hidden or shown, and a window sitting
   behind the editor is visible to the browser and to nobody else. */
import * as React from "react"

function away(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState === "hidden" || !document.hasFocus()
}

/** True while the window is hidden or unfocused. Re-renders on the boundary,
    never per mouse move. */
export function useAway(): boolean {
  const [isAway, setIsAway] = React.useState(away)
  React.useEffect(() => {
    const check = () => setIsAway(away())
    /* The first read is after mount: `hasFocus()` is unreliable during the
       initial render of a window that is still being shown. */
    check()
    document.addEventListener("visibilitychange", check)
    window.addEventListener("focus", check)
    window.addEventListener("blur", check)
    return () => {
      document.removeEventListener("visibilitychange", check)
      window.removeEventListener("focus", check)
      window.removeEventListener("blur", check)
    }
  }, [])
  return isAway
}

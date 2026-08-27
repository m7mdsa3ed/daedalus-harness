import * as React from "react"

import { matchesChord } from "@/lib/shortcuts"

/**
 * Bind one or more chords on `window`.
 *
 * The handler is held in a ref, so the listener is attached once and still sees
 * the current closure — the pattern app-shell already used by hand for the
 * new-thread key. `enabled` is how a shortcut gets scoped: several transcripts
 * can be mounted in the dock at once, and only the one the URL points at may
 * answer for Escape.
 *
 * An event another handler already claimed (`preventDefault`) is left alone, so
 * a component that owns a key locally — the slash menu's arrows, a dialog's
 * Escape — always wins over a global binding.
 */
export function useHotkey(
  chords: string | readonly string[],
  handler: (event: KeyboardEvent) => void,
  options?: { enabled?: boolean; allowRepeat?: boolean }
): void {
  const enabled = options?.enabled ?? true
  const allowRepeat = options?.allowRepeat ?? false
  // A literal array argument is a new array every render; its contents are what
  // the effect actually depends on.
  const key = typeof chords === "string" ? chords : chords.join(" ")
  const list = React.useMemo(() => key.split(" "), [key])

  const ref = React.useRef(handler)
  ref.current = handler

  React.useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.repeat && !allowRepeat) return
      if (!list.some((chord) => matchesChord(event, chord))) return
      ref.current(event)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, allowRepeat, list])
}

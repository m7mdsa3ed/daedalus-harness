import * as React from "react"

import { useBinding } from "@/lib/keybindings"
import { matchesChord, type ShortcutId } from "@/lib/shortcuts"

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

/**
 * Bind a *named* shortcut — the chords the reader has it on (lib/keybindings),
 * not the ones the release ships.
 *
 * It is also what settles the override question, in one place: with "Override
 * the browser" on (the default, and what every handler here used to do by hand)
 * the event is cancelled, so ⌘S saves the file instead of the page; with it off
 * the app still acts and the browser's own default is left alone. A handler
 * bound this way must therefore not call `preventDefault` itself — that is the
 * preference saying one thing and the code another.
 *
 * A handler that returns `false` declines the key: nothing is cancelled and the
 * event carries on, which is how a guard that only *sometimes* owns the chord
 * is expressed (`?` typed into a prompt is a character, not a command). Every
 * other return value means it was handled.
 */
export function useShortcut(
  id: ShortcutId,
  handler: (event: KeyboardEvent) => boolean | void,
  options?: { enabled?: boolean; allowRepeat?: boolean }
): void {
  const { chords, override } = useBinding(id)
  useHotkey(
    chords,
    (event) => {
      if (handler(event) === false) return
      if (override) event.preventDefault()
    },
    options
  )
}

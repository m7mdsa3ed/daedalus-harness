import * as React from "react"

import { keyboardState, subscribeKeyboard } from "@/lib/keyboard-inset"

/* The soft keyboard for the readers CSS cannot serve. Everything that can be
   placed in CSS uses `--keyboard-inset` and the recipes in
   `lib/keyboard-inset.ts` instead — a variable costs no render. */

/** Pixels of the layout viewport the keyboard is covering; 0 when closed. */
export function useKeyboardInset(): number {
  return React.useSyncExternalStore(
    subscribeKeyboard,
    () => keyboardState().height,
    () => 0
  )
}

/* Base UI's default, repeated because passing an object replaces it whole. */
const DEFAULT_COLLISION_PADDING = 5

/** What a Base UI positioner must keep clear so a flyout lands above the keyboard.
 *
 * Only under `overlaysContent`: where the keyboard shrinks the visual viewport
 * instead, floating-ui already collides against the smaller rect and padding by
 * the same number again would lift the flyout by two keyboards. */
export function useKeyboardCollisionPadding(base = DEFAULT_COLLISION_PADDING) {
  const { height, shrinksViewport } = React.useSyncExternalStore(
    subscribeKeyboard,
    keyboardState,
    () => keyboardState()
  )
  const extra = shrinksViewport ? 0 : height
  return React.useMemo(
    () => ({ top: base, right: base, bottom: base + extra, left: base }),
    [base, extra]
  )
}

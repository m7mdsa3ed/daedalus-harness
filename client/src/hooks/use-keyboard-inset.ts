import * as React from "react"

import { keyboardState, subscribeKeyboard } from "@/lib/keyboard-inset"
import { safeAreaState, subscribeSafeArea } from "@/lib/safe-area-inset"

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

/** What a Base UI positioner must keep clear: the safe-area insets on every
 * side, plus the keyboard underneath.
 *
 * The insets because the app is edge-to-edge (`viewport-fit=cover`) and the
 * shell pads itself in CSS, which a portaled flyout never sees — floating-ui
 * positions in numbers, where `env()` does not exist, so without this a menu
 * anchored near the top opens under the status bar. The keyboard only under
 * `overlaysContent`: where the keyboard shrinks the visual viewport instead,
 * floating-ui already collides against the smaller rect and padding by the
 * same number again would lift the flyout by two keyboards. Bottom takes the
 * larger of the two rather than their sum — the keyboard covers the home
 * indicator, so the two never stack. */
export function useKeyboardCollisionPadding(base = DEFAULT_COLLISION_PADDING) {
  const { height, shrinksViewport } = React.useSyncExternalStore(
    subscribeKeyboard,
    keyboardState,
    () => keyboardState()
  )
  const insets = React.useSyncExternalStore(
    subscribeSafeArea,
    safeAreaState,
    () => safeAreaState()
  )
  const extra = shrinksViewport ? 0 : height
  return React.useMemo(
    () => ({
      top: base + insets.top,
      right: base + insets.right,
      bottom: base + Math.max(insets.bottom, extra),
      left: base + insets.left,
    }),
    [base, extra, insets]
  )
}

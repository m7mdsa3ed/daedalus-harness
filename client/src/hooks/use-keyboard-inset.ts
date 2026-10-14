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

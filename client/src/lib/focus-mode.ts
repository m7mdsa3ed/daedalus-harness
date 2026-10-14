import { useSyncExternalStore } from "react"

import { IS_POPOUT, POPOUT_WINDOW_ID } from "./popout"
import { createLocalStore } from "./local-store"

const KEY = IS_POPOUT && POPOUT_WINDOW_ID
  ? `ui.focusMode:window:${POPOUT_WINDOW_ID}`
  : "ui.focusMode"
const DEFAULT = IS_POPOUT

const store = createLocalStore<boolean | null>(
  KEY,
  (value) => typeof value === "boolean" ? value : null,
  null
)

function current(): boolean {
  return store.get() ?? DEFAULT
}

function subscribe(listener: () => void): () => void {
  return store.subscribe(listener)
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribe, current, current)
}

export function setFocusMode(enabled: boolean): void {
  store.set(enabled)
}

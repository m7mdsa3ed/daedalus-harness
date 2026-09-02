/* ── Composer preferences ──
   How the box *behaves* for the person typing into it — not how a transcript
   is drawn (that is `view-options.ts`) and not a key binding (`keybindings.ts`
   stores chords, and Enter is deliberately not one: rebinding it is a broken
   composer, but choosing what a bare Enter *means* is a preference every chat
   app offers). Device-local and global, like the reading options: the hand
   that types is the same in every thread. */
import { createLocalStore } from "./local-store"

export interface ComposerPrefs {
  /** Bare Enter sends and Shift+Enter breaks the line. Off, Enter breaks the
      line and sending is the button or the steer chord (⌘/Ctrl+Enter), which is
      an ordinary send while nothing is running. Touch ignores this: Return is
      the only newline key a soft keyboard has, so it is always a newline. */
  enterSends: boolean
}

export const COMPOSER_DEFAULTS: ComposerPrefs = { enterSends: true }

const store = createLocalStore<ComposerPrefs>(
  "ui.composerPrefs",
  (raw) => {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    return {
      enterSends: typeof obj.enterSends === "boolean" ? obj.enterSends : COMPOSER_DEFAULTS.enterSends,
    }
  },
  COMPOSER_DEFAULTS
)

export const useComposerPrefs = store.use

export function setComposerPrefs(patch: Partial<ComposerPrefs>): void {
  store.set({ ...store.get(), ...patch })
}

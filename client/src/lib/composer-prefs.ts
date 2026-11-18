/* ── Composer preferences ──
   How the box *behaves* for the person typing into it — not how a transcript
   is drawn (that is `layout-options.ts`) and not a key binding (`keybindings.ts`
   stores chords, and Enter is deliberately not one: rebinding it is a broken
   composer, but choosing what a bare Enter *means* is a preference every chat
   app offers). Device-local and global, like the reading options: the hand
   that types is the same in every thread. */
import { createLocalStore } from "./local-store"
import {
  SCREEN_FPS,
  SCREEN_QUALITIES,
  SCREEN_RECORD_DEFAULTS,
  type ScreenFps,
  type ScreenQuality,
  type ScreenRecordPrefs,
} from "./screen-record-options"

export interface ComposerPrefs extends ScreenRecordPrefs {
  /** Bare Enter sends and Shift+Enter breaks the line. Off, Enter breaks the
      line and sending is the button or the steer chord (⌘/Ctrl+Enter), which is
      an ordinary send while nothing is running. Touch ignores this: Return is
      the only newline key a soft keyboard has, so it is always a newline. */
  enterSends: boolean
  /** Which of the two voice modes the row's one voice key runs on a plain
      click — a dictated note, a call, or a screen recording (`composer/voice-button.tsx`). A note by
      default: it is the one that ends with words in the box, and the one that
      needs nothing set up. */
  voiceMode: "note" | "call" | "screen"
}

export const COMPOSER_DEFAULTS: ComposerPrefs = { enterSends: true, voiceMode: "note", ...SCREEN_RECORD_DEFAULTS }

const store = createLocalStore<ComposerPrefs>(
  "ui.composerPrefs",
  (raw) => {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    return {
      enterSends: typeof obj.enterSends === "boolean" ? obj.enterSends : COMPOSER_DEFAULTS.enterSends,
      voiceMode: obj.voiceMode === "call" || obj.voiceMode === "screen" ? obj.voiceMode : "note",
      screenQuality: SCREEN_QUALITIES.some((q) => q.id === obj.screenQuality)
        ? (obj.screenQuality as ScreenQuality)
        : COMPOSER_DEFAULTS.screenQuality,
      screenFps: SCREEN_FPS.includes(obj.screenFps as ScreenFps) ? (obj.screenFps as ScreenFps) : COMPOSER_DEFAULTS.screenFps,
      screenAudio: typeof obj.screenAudio === "boolean" ? obj.screenAudio : COMPOSER_DEFAULTS.screenAudio,
    }
  },
  COMPOSER_DEFAULTS
)

export const useComposerPrefs = store.use

export function setComposerPrefs(patch: Partial<ComposerPrefs>): void {
  store.set({ ...store.get(), ...patch })
}

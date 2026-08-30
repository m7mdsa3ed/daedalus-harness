/* ── Keyboard shortcuts ──
   One table and one matcher, two consumers: the code that binds a key and the
   sheet that lists it (components/shortcuts-help). A binding that is not in
   SHORTCUTS is a binding nobody can find, so both sides read the same rows.

   Chords are written the way the sheet reads them — "mod+k", "esc", "up" — with
   `mod` standing for ⌘ on Apple and Ctrl everywhere else, which is what every
   handler in this app already accepted by hand.

   Where a binding lives is a scoping decision, not a style one. Global keys go
   on `window`; thread keys go on `window` too but are gated on the thread the
   URL points at, because the dock can have several transcripts mounted at once
   and only one of them is the one you are looking at; composer keys stay on the
   textarea, where the caret is the thing they are about. */
import type * as React from "react"

const APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)

/** `KeyboardEvent.key`, in the vocabulary the chords are written in. */
function normalizeKey(key: string): string {
  const k = key.toLowerCase()
  if (k === "escape") return "esc"
  if (k === " " || k === "spacebar") return "space"
  if (k.startsWith("arrow")) return k.slice(5)
  return k
}

export function matchesChord(
  event: KeyboardEvent | React.KeyboardEvent,
  chord: string
): boolean {
  const parts = chord.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  const mods = new Set(parts)
  if (event.metaKey || event.ctrlKey ? !mods.has("mod") : mods.has("mod")) return false
  if (event.altKey !== mods.has("alt")) return false
  /* Shift is a modifier only for keys that mean something without it: "?" IS
     shift+/ on most layouts, and requiring the modifier too would never match. */
  const shiftMatters = key.length > 1 || /^[a-z0-9]$/.test(key)
  if (shiftMatters && event.shiftKey !== mods.has("shift")) return false
  return normalizeKey(event.key) === key
}

/** True while the event is going into something being typed into — the one
    place a bare letter or digit must never be a command. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable
}

/** True while the event is going into something Enter or Space already
    activates. A focused button must not answer twice — once as itself and once
    as the shortcut. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('button,a[href],summary,[role="button"],[role="link"]')
}

/** A dialog, menu or popup is open, so Escape belongs to it and not to us.
    Base UI unmounts its popups when closed, so presence is the whole test. */
export function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'
  )
}

const SYMBOLS: Record<string, string> = {
  mod: APPLE ? "⌘" : "Ctrl",
  shift: APPLE ? "⇧" : "Shift",
  alt: APPLE ? "⌥" : "Alt",
  esc: "Esc",
  enter: APPLE ? "↩" : "Enter",
  up: "↑",
  down: "↓",
  space: "Space",
}

/** A chord as the keycaps to print for it, in order. */
export function chordKeys(chord: string): string[] {
  return chord
    .split("+")
    .map((part) => SYMBOLS[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}

/** A chord on one line, for somewhere too narrow for keycaps. */
export function formatChord(chord: string): string {
  const caps = chordKeys(chord)
  // Apple stacks its glyphs; everywhere else the plus is what people write.
  return APPLE ? caps.join("") : caps.join("+")
}

export type ShortcutScope = "Global" | "Thread" | "Editor" | "Composer" | "Questions"

export interface ShortcutDef {
  scope: ShortcutScope
  label: string
  /** Chords that trigger it. The first is the one the sheet leads with. */
  chords: string[]
  /** Printed instead of the chords when the real binding is a range. */
  display?: string[]
  note?: string
}

/* The chords handlers bind, named once so a rename cannot desync the sheet from
   the key. Anything not referenced here is a key some component owns privately
   (the slash menu's arrows, the questionnaire's digits). */
export const KEYS = {
  palette: "mod+k",
  newThread: "mod+n",
  sidebar: "mod+b",
  help: ["mod+/", "?"],
  send: "mod+enter",
  /** Into the running turn, past the queue. */
  steer: "mod+shift+enter",
  historyPrev: "up",
  historyNext: "down",
  /** Skip the question, reject the permission, stop the turn — in that order. */
  escape: "esc",
  /** Workspace. Not `mod+w`: Electron gives that to close-window, and a chord
      that closes the app when the dock is empty is not a panel shortcut. */
  splitRight: "mod+\\",
  reopenPanel: "mod+shift+t",
  /** Not `mod+b` — that is the app sidebar, and the two are different panes. */
  explorer: "mod+shift+e",
  /** VS Code's panel chord, not its ⌃` terminal one: `matchesChord` folds Ctrl
      into `mod` by design (⌘ on Apple, Ctrl elsewhere), so a standalone `ctrl`
      is not part of the vocabulary — and ⌘` is macOS's own "cycle windows",
      which this app should not be taking. */
  terminal: "mod+j",
  /** VS Code's, and free here. */
  sourceControl: "mod+shift+g",
  output: "mod+shift+u",
  /** The editor panel's own — bound on the window when a dirty file is in
      front, and inside the editor itself where the caret lives. */
  save: "mod+s",
} as const

export const SHORTCUTS: ShortcutDef[] = [
  { scope: "Global", label: "Command palette", chords: [KEYS.palette] },
  { scope: "Global", label: "New thread", chords: [KEYS.newThread] },
  { scope: "Global", label: "Toggle the sidebar", chords: [KEYS.sidebar] },
  {
    scope: "Global",
    label: "Jump to a tab in this group",
    chords: ["mod+1"],
    display: [SYMBOLS.mod + "1…9"],
    note: "Counts the tabs in the group you are looking at, which is every open thread until the workspace is split.",
  },
  { scope: "Global", label: "Split the panel to the right", chords: [KEYS.splitRight] },
  {
    scope: "Editor",
    label: "Save the file",
    chords: [KEYS.save],
    note: "Only in an editor panel, and only while it has unsaved changes — nothing else in the app claims it.",
  },
  {
    scope: "Global",
    label: "Toggle output and problems",
    chords: [KEYS.output],
    note: "One buffer — Problems is the lines that named a file and a line number.",
  },
  {
    scope: "Global",
    label: "Toggle source control",
    chords: [KEYS.sourceControl],
    note: "Staging, commits and branches for the current thread's project.",
  },
  {
    scope: "Global",
    label: "Open a terminal",
    chords: [KEYS.terminal],
    note: "A shell on the Daedalus server, in the current thread's project directory.",
  },
  {
    scope: "Global",
    label: "Toggle the file explorer",
    chords: [KEYS.explorer],
    note: "The workspace tree for the current thread's project, beside the transcript.",
  },
  {
    scope: "Global",
    label: "Reopen the last closed panel",
    chords: [KEYS.reopenPanel],
    note: "Walks back through the last ten, the way a browser reopens tabs.",
  },
  {
    scope: "Global",
    label: "Save the open file",
    chords: [KEYS.save],
    note: "When the editor panel is the one in front and the file has changes.",
  },
  { scope: "Global", label: "Keyboard shortcuts", chords: [...KEYS.help] },

  {
    scope: "Composer",
    label: "Send",
    chords: ["enter", KEYS.send],
    note: "While the agent is working this queues the message for when it finishes. Shift+Enter inserts a newline. On touch it is the other way round — Return is a newline and the send button sends.",
  },
  {
    scope: "Composer",
    label: "Steer the running turn",
    chords: [KEYS.steer],
    note: "Sends into the turn already running instead of queueing behind it.",
  },
  {
    scope: "Composer",
    label: "Previous prompt",
    chords: [KEYS.historyPrev],
    note: "From the start of the composer, the way a shell recalls a command.",
  },
  { scope: "Composer", label: "Next prompt", chords: [KEYS.historyNext] },
  {
    scope: "Composer",
    label: "Leave the prompt history",
    chords: [KEYS.escape],
    note: "Puts back whatever you had typed before you started walking back.",
  },

  {
    scope: "Thread",
    label: "Stop the running turn",
    chords: [KEYS.escape],
    note: "When nothing is waiting on an answer.",
  },

  {
    scope: "Questions",
    label: "Skip the question / reject the permission",
    chords: [KEYS.escape],
    note: "Skipping is a real answer — the agent is told you passed and the turn carries on.",
  },
  {
    scope: "Questions",
    label: "Choose an option",
    chords: ["1"],
    display: ["1…9"],
    note: "While the composer does not have focus.",
  },
  {
    scope: "Questions",
    label: "Take the recommended option",
    chords: ["enter"],
    note: "While the composer does not have focus.",
  },
]

export const SHORTCUT_SCOPES: ShortcutScope[] = ["Global", "Thread", "Editor", "Composer", "Questions"]

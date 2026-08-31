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

/** The chord a keypress spells, in this module's vocabulary — the inverse of
    `matchesChord`, and what the settings recorder writes down. Returns null for
    a press that is only modifiers, which is every intermediate state of typing
    a chord. */
export function chordFromEvent(event: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = normalizeKey(event.key)
  if (["shift", "control", "alt", "meta", "os", "dead", "unidentified"].includes(key)) return null
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("mod")
  if (event.altKey) parts.push("alt")
  /* Shift is part of the chord only where the key means something without it —
     the same rule `matchesChord` applies, or a recorded chord would never match
     the press that recorded it. */
  if (event.shiftKey && (key.length > 1 || /^[a-z0-9]$/.test(key))) parts.push("shift")
  parts.push(key)
  return parts.join("+")
}

/* ── What the browser (or the OS) already does with a chord ──
   A shortcut the app binds is not automatically a shortcut the app *gets*.
   Three cases, and the settings page has to tell them apart rather than
   promising a binding it cannot deliver:

   - `reserved: "hard"` — the browser keeps the key. Chrome and Edge never
     deliver ⌘/Ctrl+N, T, W or Q to the page at all, so `preventDefault` has
     nothing to cancel and the binding is dead in a tab. It still works in the
     installed desktop app, where the page is the whole window.
   - `reserved: "soft"` — the browser has a default (Save, Print, Find…) but the
     page is allowed to cancel it. This is what "Override the browser" is for.
   - absent — nobody else wants it.

   Written against Chromium, which is what the PWA and the Electron shell both
   are; Firefox and Safari are a little more permissive, never less. */
export type ReservedKind = "hard" | "soft"

export interface ReservedChord {
  /** What the browser does with it, in words, for the warning. */
  action: string
  reserved: ReservedKind
}

const RESERVED: Record<string, ReservedChord> = {
  "mod+n": { action: "New window", reserved: "hard" },
  "mod+shift+n": { action: "New incognito window", reserved: "hard" },
  "mod+t": { action: "New tab", reserved: "hard" },
  "mod+shift+t": { action: "Reopen the last closed tab", reserved: "hard" },
  "mod+w": { action: "Close the tab", reserved: "hard" },
  "mod+shift+w": { action: "Close the window", reserved: "hard" },
  "mod+q": { action: "Quit the browser", reserved: "hard" },
  "mod+shift+q": { action: "Quit the browser", reserved: "hard" },
  "mod+r": { action: "Reload the page", reserved: "hard" },
  "mod+shift+r": { action: "Hard reload", reserved: "hard" },
  "mod+l": { action: "Focus the address bar", reserved: "hard" },
  "mod+tab": { action: "Next tab", reserved: "hard" },
  "mod+s": { action: "Save the page", reserved: "soft" },
  "mod+p": { action: "Print", reserved: "soft" },
  "mod+f": { action: "Find in page", reserved: "soft" },
  "mod+g": { action: "Find next", reserved: "soft" },
  "mod+o": { action: "Open a file", reserved: "soft" },
  "mod+d": { action: "Bookmark the page", reserved: "soft" },
  "mod+j": { action: "Downloads", reserved: "soft" },
  "mod+h": { action: "History", reserved: "soft" },
  "mod+k": { action: "Search from the address bar", reserved: "soft" },
  "mod+e": { action: "Search from the address bar", reserved: "soft" },
  "mod+u": { action: "View source", reserved: "soft" },
  "mod+shift+p": { action: "New private window", reserved: "soft" },
  "mod+shift+o": { action: "Bookmark manager", reserved: "soft" },
  "mod+shift+j": { action: "Developer tools", reserved: "soft" },
  "mod+shift+i": { action: "Developer tools", reserved: "soft" },
  "mod+shift+c": { action: "Inspect element", reserved: "soft" },
  "mod+shift+delete": { action: "Clear browsing data", reserved: "soft" },
  "mod+plus": { action: "Zoom in", reserved: "soft" },
  "mod+-": { action: "Zoom out", reserved: "soft" },
  "mod+0": { action: "Reset zoom", reserved: "soft" },
  f1: { action: "Browser help", reserved: "soft" },
  f3: { action: "Find next", reserved: "soft" },
  f5: { action: "Reload the page", reserved: "hard" },
  f6: { action: "Cycle browser panes", reserved: "soft" },
  f11: { action: "Full screen", reserved: "soft" },
  f12: { action: "Developer tools", reserved: "hard" },
}

/** What else wants this chord, if anything. */
export function reservedChord(chord: string): ReservedChord | undefined {
  return RESERVED[chord.toLowerCase()]
}

export type ShortcutScope = "Global" | "Thread" | "Editor" | "Composer" | "Questions"

export type ShortcutId =
  | "palette"
  | "newThread"
  | "sidebar"
  | "help"
  | "tabJump"
  | "splitRight"
  | "reopenPanel"
  | "terminal"
  | "save"
  | "send"
  | "steer"
  | "historyPrev"
  | "historyNext"
  | "historyLeave"
  | "threadStop"
  | "questionSkip"
  | "questionChoose"
  | "questionAccept"

export interface ShortcutDef {
  /** Stable name. What a rebinding is stored against, so renaming the label
      cannot orphan somebody's custom chord. */
  id: ShortcutId
  scope: ShortcutScope
  label: string
  /** The chords it ships with. The first is the one the sheet leads with, and
      what "Reset" puts back. */
  chords: string[]
  /** Printed instead of the chords when the real binding is a range. */
  display?: string[]
  note?: string
  /** False for a key whose meaning is the key — Enter sends, Escape backs out,
      the arrows walk the history, a digit picks the option it names. These are
      listed in settings so the sheet stays complete, but they are not offered a
      recorder: rebinding Enter is not a preference, it is a broken composer. */
  rebindable?: boolean
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
  /** Into the running turn, past the queue. ⌘/Ctrl+Enter is the one people
      reach for while an agent is working — it used to send, which while a turn
      is running means *queue*, so the deliberate chord asked for the ordinary
      thing and the ordinary chord asked for nothing in particular. Both spell
      "steer" now; ⇧ survives as the older muscle memory. */
  steer: ["mod+enter", "mod+shift+enter"],
  historyPrev: "up",
  historyNext: "down",
  /** Skip the question, reject the permission, stop the turn — in that order. */
  escape: "esc",
  /** Workspace. Not `mod+w`: Electron gives that to close-window, and a chord
      that closes the app when the dock is empty is not a panel shortcut. */
  splitRight: "mod+\\",
  reopenPanel: "mod+shift+t",
  /** VS Code's panel chord, not its ⌃` terminal one: `matchesChord` folds Ctrl
      into `mod` by design (⌘ on Apple, Ctrl elsewhere), so a standalone `ctrl`
      is not part of the vocabulary — and ⌘` is macOS's own "cycle windows",
      which this app should not be taking. */
  terminal: "mod+j",
  /** The editor panel's own — bound on the window when a dirty file is in
      front, and inside the editor itself where the caret lives. */
  save: "mod+s",
} as const

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", scope: "Global", label: "Command palette", chords: [KEYS.palette], rebindable: true },
  { id: "newThread", scope: "Global", label: "New thread", chords: [KEYS.newThread], rebindable: true },
  { id: "sidebar", scope: "Global", label: "Toggle the sidebar", chords: [KEYS.sidebar], rebindable: true },
  {
    id: "tabJump",
    scope: "Global",
    label: "Jump to a tab in this group",
    chords: ["mod+1"],
    display: [SYMBOLS.mod + "1…9"],
    note: "Counts the tabs in the group you are looking at, which is every open thread until the workspace is split.",
  },
  {
    id: "splitRight",
    scope: "Global",
    label: "Split the panel to the right",
    chords: [KEYS.splitRight],
    rebindable: true,
  },
  {
    id: "save",
    scope: "Editor",
    label: "Save the file",
    chords: [KEYS.save],
    rebindable: true,
    note: "Only in an editor panel, and only while it has unsaved changes — nothing else in the app claims it.",
  },
  {
    id: "terminal",
    scope: "Global",
    label: "Open a terminal",
    chords: [KEYS.terminal],
    rebindable: true,
    note: "A shell on the Daedalus server, in the current thread's project directory.",
  },
  {
    id: "reopenPanel",
    scope: "Global",
    label: "Reopen the last closed panel",
    chords: [KEYS.reopenPanel],
    rebindable: true,
    note: "Walks back through the last ten, the way a browser reopens tabs.",
  },
  { id: "help", scope: "Global", label: "Keyboard shortcuts", chords: [...KEYS.help], rebindable: true },

  {
    id: "send",
    scope: "Composer",
    label: "Send",
    chords: ["enter"],
    note: "While the agent is working this queues the message for when it finishes. Shift+Enter inserts a newline. On touch it is the other way round — Return is a newline and the send button sends.",
  },
  {
    id: "steer",
    scope: "Composer",
    label: "Steer the running turn",
    chords: [...KEYS.steer],
    rebindable: true,
    note: "Sends into the turn already running instead of queueing behind it. With nothing running it is an ordinary send.",
  },
  {
    id: "historyPrev",
    scope: "Composer",
    label: "Previous prompt",
    chords: [KEYS.historyPrev],
    note: "From the start of the composer, the way a shell recalls a command.",
  },
  { id: "historyNext", scope: "Composer", label: "Next prompt", chords: [KEYS.historyNext] },
  {
    id: "historyLeave",
    scope: "Composer",
    label: "Leave the prompt history",
    chords: [KEYS.escape],
    note: "Puts back whatever you had typed before you started walking back.",
  },

  {
    id: "threadStop",
    scope: "Thread",
    label: "Stop the running turn",
    chords: [KEYS.escape],
    note: "When nothing is waiting on an answer.",
  },

  {
    id: "questionSkip",
    scope: "Questions",
    label: "Skip the question / reject the permission",
    chords: [KEYS.escape],
    note: "Skipping is a real answer — the agent is told you passed and the turn carries on.",
  },
  {
    id: "questionChoose",
    scope: "Questions",
    label: "Choose an option",
    chords: ["1"],
    display: ["1…9"],
    note: "While the composer does not have focus.",
  },
  {
    id: "questionAccept",
    scope: "Questions",
    label: "Take the recommended option",
    chords: ["enter"],
    note: "While the composer does not have focus.",
  },
]

export const SHORTCUT_SCOPES: ShortcutScope[] = ["Global", "Thread", "Editor", "Composer", "Questions"]

export const shortcutDef = (id: ShortcutId): ShortcutDef =>
  SHORTCUTS.find((entry) => entry.id === id) ?? SHORTCUTS[0]

/** The chords a shortcut ships with. */
export const defaultChords = (id: ShortcutId): string[] => shortcutDef(id).chords

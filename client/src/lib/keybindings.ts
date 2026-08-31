/* ── Custom keyboard shortcuts ──
   `lib/shortcuts` says what a shortcut *is* and what it ships with; this is the
   reader's own answer to it. Device-local and global — one set of chords for
   every thread and every server, the same bargain `lib/view-options` makes,
   because which key does what is a property of the hands at the keyboard and
   not of anything the server stores.

   Two values per shortcut, and the second is the point of the feature:

   - `chords` — what to listen for. Absent means the shipped ones, so a release
     that moves a default moves it for everybody who never touched that row.
   - `override` — whether the handler cancels whatever else wanted the key.
     A binding is not automatically a *win*: ⌘F is Find in page and ⌘S saves the
     document unless the page says otherwise, and saying otherwise is
     `preventDefault()`. On by default (which is what every handler in the app
     did by hand before this existed), off for the reader who would rather keep
     the browser's. It cannot buy back a chord the browser never delivers —
     `reservedChord(chord).reserved === "hard"` — which is exactly what the
     settings page has to say out loud rather than let a dead binding be
     discovered by pressing it. */
import { useCallback, useSyncExternalStore } from "react"

import { defaultChords, reservedChord, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts"

export interface Binding {
  chords: string[]
  override: boolean
}

/** What is actually stored: only the parts that differ from the defaults. */
interface StoredBinding {
  chords?: string[]
  override?: boolean
}

const STORAGE_KEY = "ui.keybindings"

const IDS = new Set<string>(SHORTCUTS.map((entry) => entry.id))

/** The stored blob is user-editable, outlives any one release and is read on
    every keystroke path, so an id this build has never heard of — or a chord
    that is not a string — must not reach the resolved map. */
function pick(raw: unknown): Record<string, StoredBinding> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, StoredBinding> = {}
  for (const [id, value] of Object.entries(source)) {
    if (!IDS.has(id) || !value || typeof value !== "object") continue
    const entry = value as Record<string, unknown>
    const next: StoredBinding = {}
    if (Array.isArray(entry.chords)) {
      const chords = entry.chords.filter((chord): chord is string => typeof chord === "string" && !!chord)
      // An empty list is "unbound", which is a real choice; a list of junk is not.
      if (chords.length === entry.chords.length) next.chords = chords
    }
    if (typeof entry.override === "boolean") next.override = entry.override
    if (Object.keys(next).length) out[id] = next
  }
  return out
}

function read(): Record<string, StoredBinding> {
  try {
    return pick(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
  } catch {
    return {}
  }
}

function resolveAll(stored: Record<string, StoredBinding>): Record<ShortcutId, Binding> {
  const out = {} as Record<ShortcutId, Binding>
  for (const entry of SHORTCUTS) {
    const custom = stored[entry.id]
    out[entry.id] = {
      chords: custom?.chords ?? entry.chords,
      override: custom?.override ?? true,
    }
  }
  return out
}

const listeners = new Set<() => void>()

/* Memoised for the same reason view-options' is: a fresh object per snapshot
   read is an infinite render loop in useSyncExternalStore, not an
   inefficiency. */
let stored = read()
let resolved = resolveAll(stored)

function commit(next: Record<string, StoredBinding>) {
  stored = next
  resolved = resolveAll(next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  for (const listener of listeners) listener()
}

function edit(id: ShortcutId, patch: StoredBinding) {
  const next = { ...stored, [id]: { ...stored[id], ...patch } }
  commit(next)
}

export function setShortcutChords(id: ShortcutId, chords: string[]): void {
  edit(id, { chords })
}

export function setShortcutOverride(id: ShortcutId, override: boolean): void {
  edit(id, { override })
}

/** Back to what the release ships — which is not the same as writing today's
    defaults down, so a later release that moves the chord still moves it. */
export function resetShortcut(id: ShortcutId): void {
  const next = { ...stored }
  delete next[id]
  commit(next)
}

export function resetAllShortcuts(): void {
  commit({})
}

export function isCustomized(id: ShortcutId): boolean {
  return !!stored[id]
}

/** Non-reactive read, for the places a chord is needed outside a render. */
export function bindingFor(id: ShortcutId): Binding {
  return resolved[id] ?? { chords: defaultChords(id), override: true }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useKeybindings(): Record<ShortcutId, Binding> {
  const snapshot = () => resolved
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useBinding(id: ShortcutId): Binding {
  const snapshot = useCallback(() => bindingFor(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The chords bound to a shortcut right now. */
export function useChords(id: ShortcutId): string[] {
  return useBinding(id).chords
}

/** The one chord to *print* for a shortcut — the first bound, or nothing when
    the reader has unbound it, which is what `Shortcut` renders as absent. */
export function useChord(id: ShortcutId): string | undefined {
  return useChords(id)[0]
}

/** Every other shortcut that answers to this chord. Scope is carried rather
    than filtered on: Escape in a composer and Escape in a thread are the same
    key deliberately (the chain in ThreadView orders them), so a collision is
    something to *say* — with the scopes named — and not something to refuse. */
export function chordConflicts(chord: string, except: ShortcutId): ShortcutId[] {
  const wanted = chord.toLowerCase()
  return SHORTCUTS.filter(
    (entry) => entry.id !== except && bindingFor(entry.id).chords.some((c) => c.toLowerCase() === wanted)
  ).map((entry) => entry.id)
}

/** Everything the settings page has to warn about before a chord is saved. */
export interface ChordWarning {
  kind: "hard" | "soft" | "conflict"
  text: string
}

export function chordWarnings(chord: string, id: ShortcutId, desktop: boolean): ChordWarning[] {
  const out: ChordWarning[] = []
  const reserved = reservedChord(chord)
  if (reserved) {
    out.push(
      reserved.reserved === "hard"
        ? {
            kind: "hard",
            text: desktop
              ? `${reserved.action} in a browser tab. The desktop app gets the key, so the binding works here — on the web it never will.`
              : `${reserved.action}. The browser keeps this one for itself and never hands it to a page, so this binding will not fire in a tab — only in the installed desktop app.`,
          }
        : {
            kind: "soft",
            text: `${reserved.action} in the browser. Leave "Override" on and the app takes the key instead; turn it off and both happen.`,
          }
    )
  }
  const clash = chordConflicts(chord, id)
  if (clash.length)
    out.push({
      kind: "conflict",
      text: `Also bound to ${clash
        .map((other) => SHORTCUTS.find((entry) => entry.id === other)?.label ?? other)
        .join(", ")}. Whichever is in scope answers first.`,
    })
  return out
}

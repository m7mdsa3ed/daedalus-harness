import { useSyncExternalStore } from "react"

/* ── Custom terminal helper keys ──
   The on-screen keys a terminal needs (Tab, Ctrl, arrows, …) ship built in; but
   an Android soft keyboard can never reach an arbitrary escape sequence, so the
   row is also user-extensible. These are this device's additions — stored in
   localStorage next to drafts and pins, never synced, because the keyboard is
   per-device: a Mac has one, a phone has another.

   Each entry is the pair that matters to the user (a label and the bytes it
   sends) plus an id so a re-ordered row keeps identity through a reload. */

const STORAGE_KEY = "ui.terminalKeys"

export interface TerminalKey {
  /** Stable identity for React keys and dedup; minted on add. */
  id: string
  label: string
  /** The raw bytes sent to the PTY (may be an escape sequence). */
  send: string
}

function isTerminalKey(value: unknown): value is TerminalKey {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as TerminalKey).id === "string" &&
    typeof (value as TerminalKey).label === "string" &&
    typeof (value as TerminalKey).send === "string"
  )
}

function read(): TerminalKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter(isTerminalKey) : []
  } catch {
    return []
  }
}

let cache = read()
const listeners = new Set<() => void>()

function write(keys: TerminalKey[]) {
  cache = keys
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // Losing a custom key is survivable; throwing out of a tap handler is not.
  }
  for (const listener of listeners) listener()
}

export const terminalKeysSnapshot = (): TerminalKey[] => cache

export function subscribeTerminalKeys(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function addTerminalKey(key: Omit<TerminalKey, "id">): void {
  /* A short, collision-safe id: index + a few random base36 chars. An id never
     has to be unique across reloads, only within the list — and custom ids can
     never shadow a builtin key, which has a bare name. */
  const id = `k${cache.length + 1}-${Math.random().toString(36).slice(2, 7)}`
  write([...cache, { ...key, id }])
}

export function removeTerminalKey(id: string): void {
  write(cache.filter((key) => key.id !== id))
}

/* Another tab editing the same device's keyboard is editing this one too. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  cache = read()
  for (const listener of listeners) listener()
})

/** The custom keys, live — the terminal panel and its config read the same list. */
export function useTerminalKeys(): TerminalKey[] {
  return useSyncExternalStore(subscribeTerminalKeys, terminalKeysSnapshot, terminalKeysSnapshot)
}

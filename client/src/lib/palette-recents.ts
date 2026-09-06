/* ── Recently used commands ──
   Which commands this person actually reaches for, newest first. Device-local
   like pins and view options, and for the same reason: it is a fact about the
   reader, not about the install — a habit formed on a laptop should not
   reorder the palette on someone else's phone.

   What is remembered is the command *id*, never the row: a row is rebuilt
   every keystroke out of the store, the dock and the current thread, so the id
   is the only part of it that survives being closed. That also makes the list
   self-cleaning — an id whose command no longer applies (Stop the turn, on a
   thread that has finished) simply matches nothing when the palette next
   resolves it, and is drawn nowhere until the command is offered again.

   Only the root page writes here, and only for the rows that are commands:
   a thread row is a destination the recents list in the sidebar already
   answers for, and the two query-shaped fallbacks are about whatever was in
   the box rather than about themselves. See `root-page.tsx`. */
import { createLocalStore } from "./local-store"

/** How many are kept. Deliberately more than are ever shown: the tail is what
    survives a run of one-off commands, so a habit is not evicted by a morning
    spent switching themes. */
const LIMIT = 24

const store = createLocalStore<string[]>(
  "ui.paletteRecents",
  (raw) =>
    Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string").slice(0, LIMIT)
      : [],
  []
)

/** Newest first. */
export const usePaletteRecents = store.use

export function recordPaletteCommand(id: string): void {
  const previous = store.get()
  store.set([id, ...previous.filter((other) => other !== id)].slice(0, LIMIT))
}

export function clearPaletteRecents(): void {
  store.set([])
}

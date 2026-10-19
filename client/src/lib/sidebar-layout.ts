/* ── Sidebar open state ──
   Whether the sidebar column is shown, remembered across reloads. Device-local
   and global, like the layout options: how a person wants their workspace to
   look is a property of the reader and their screen, not of any one thread or
   any one account, so it persists in localStorage rather than on the server.

   This is a *state*, not an option, so it is not in `layout-options.ts`: that
   store's snapshot is read by every transcript row, and a toggle that replaced
   it would re-render all of them. The sidebar's variant, sort, filter and
   every other pick live there (and `layout-options` strips the old `variant`
   out of this key on first run). */
import { createLocalStore } from "./local-store"

const store = createLocalStore<{ open: boolean }>(
  "ui.sidebarLayout",
  (raw) => ({ open: !(raw && typeof raw === "object" && (raw as { open?: unknown }).open === false) }),
  { open: true }
)

export const useSidebarOpen = () => store.use().open
export const setSidebarOpen = (open: boolean) => store.set({ open })

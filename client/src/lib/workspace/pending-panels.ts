/* ── Panels queued for the next thread to open ──
   The dock exists only on a thread route, so a page that is *not* one — the
   build page, the project overview — cannot open a panel beside the thread
   it is about to navigate to: `openPanel` before the dock has mounted is a
   no-op. What it can do is say which panels the next thread should open
   with, the way `session-tabs.ts` says "in a new tab".

   One-shot and consumed by the shell's route effect right after it opens the
   chat, so the chat is the panel the queued ones split against — a preview
   queued first would have become the group the chat then tabbed into. */
import type { OpenPanelOptions } from "@/components/workspace/dock"
import type { PanelDescriptor } from "@/lib/workspace/panels"

interface Queued {
  panel: PanelDescriptor
  options?: OpenPanelOptions
}

let queue: Queued[] = []

export function queuePanel(panel: PanelDescriptor, options?: OpenPanelOptions): void {
  queue.push({ panel, options })
}

export function consumeQueuedPanels(): Queued[] {
  const taken = queue
  queue = []
  return taken
}

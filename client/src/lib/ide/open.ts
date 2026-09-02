/* ── Requests into the IDE ──
   A transcript chip, a diff button, a turn's "N files changed" all resolve to
   one of these. They are queued rather than performed, because the caller has
   just asked the dock to open the IDE panel and the workbench may still be
   booting — or may not have been downloaded yet.

   **Nothing in this file imports the workbench.** It is reached from the
   transcript, which every reader loads; a static import of the extension API
   here would put VS Code in the app's entry chunk. So this half is a queue
   and a callback, and `lib/ide/perform.ts` — which does import the API — is
   registered by boot once the panel has pulled it in. A request made before
   then simply waits.

   The panel is opened by the caller: the IDE cannot open itself. */

export type IdeRequest =
  | { kind: "file"; projectId: string; path: string; line?: number; endLine?: number }
  | { kind: "diff"; projectId: string; path: string }
  | { kind: "changes"; projectId: string; sessionId: string; scope: string }

type Performer = (request: IdeRequest) => Promise<void>

const queue: IdeRequest[] = []
let performer: Performer | null = null
let draining = false

/** Boot hands over the performer once the workbench is up. */
export function setIdePerformer(next: Performer): void {
  performer = next
  void drain()
}

export function requestIde(request: IdeRequest): void {
  queue.push(request)
  void drain()
}

async function drain(): Promise<void> {
  if (draining || !performer) return
  draining = true
  try {
    while (queue.length > 0 && performer) {
      const request = queue.shift()!
      await performer(request)
    }
  } finally {
    draining = false
  }
}

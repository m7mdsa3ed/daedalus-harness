/* ── Opening a terminal ──
   Two openers that create a terminal server-side and hand the dock a panel to
   draw it in. They lived in `components/workspace/terminal-panel.tsx` next to
   the panel that renders one, which put xterm — the library, its three addons
   and its stylesheet — into the entry chunk, because the shell's ⌃` and the
   palette's row both import the opener and neither of them draws a terminal.

   Nothing here touches xterm: a terminal is the server's, so opening one is a
   POST and a panel descriptor. The panel is what needs the library, and it is
   lazy (see the component map in `workspace/dock-surface.tsx`).

   `useDock`'s return type is imported for its shape only — a `type` import, so
   it is erased and this module does not pull the dock in either. */
import type { PanelTarget, useDock } from "@/components/workspace/dock-context"
import { describeError, reportError } from "@/lib/errors"
import { queuePanel } from "@/lib/workspace/pending-panels"
import { createTerminal, startHelperTerminal } from "@/lib/workspace/terminals"

/** Open a new terminal for a project and put it in the dock. Exported because
    the palette and the shell's ⌃` both want it and neither owns a panel. */
export async function openTerminal(
  dock: ReturnType<typeof useDock>,
  projectId: string,
  /** Where it lands — carried across the round trip rather than remembered. */
  into?: PanelTarget
): Promise<void> {
  try {
    const created = await createTerminal(projectId)
    dock.openPanel(
      { kind: "terminal", projectId, terminalId: created.id },
      { direction: "below", into }
    )
  } catch (err) {
    const { title } = describeError(err)
    reportError(err, title === "The request failed" ? "Couldn't open a terminal" : undefined)
  }
}

/**
 * Run a project helper: a terminal, opened on the helper's own command.
 *
 * A helper is a shell line somebody saved, and a shell line asks things —
 * "which environment?", a password, `[y/N]`. The old run captured stdout into
 * a dialog with no stdin behind it, so any of those hung until the timeout
 * killed it with the question as the final line. Here the same command gets a
 * PTY, and the panel it lands in is the one the harness already knows how to
 * draw a PTY in.
 *
 * `dock` is null on a route that has no dock — the project page — where the
 * panel is *queued* for the next thread instead, the same trade `openRules`
 * makes there. The terminal itself is already running by then either way: it
 * is the server's, and it survives the trip.
 */
export async function openHelperTerminal(
  projectId: string,
  helper: { id: string; name: string },
  dock: ReturnType<typeof useDock> | null
): Promise<boolean> {
  try {
    const created = await startHelperTerminal(projectId, helper.id)
    /* Closed when the command finishes cleanly: a helper is an errand, and a
       panel left behind on every successful run is a strip of dead shells to
       tidy by hand. A failure stays put, output and all. */
    const panel = { kind: "terminal", projectId, terminalId: created.id, closeOnExit: true } as const
    if (dock) dock.openPanel(panel, { direction: "below" })
    else queuePanel(panel, { direction: "below" })
    return true
  } catch (err) {
    const { title } = describeError(err)
    reportError(err, title === "The request failed" ? `Couldn't run ${helper.name}` : undefined)
    return false
  }
}

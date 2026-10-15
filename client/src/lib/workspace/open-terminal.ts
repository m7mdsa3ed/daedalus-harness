/* ── Opening a terminal ──
   Two openers that create a terminal server-side and hand the right panel a
   shell to draw. They live apart from `components/workspace/terminal-panel.tsx`
   because that panel is xterm — the library, its three addons and its
   stylesheet — and the shell's ⌃` and the palette's row import the opener
   without drawing a terminal.

   Nothing here touches xterm: a terminal is the server's, so opening one is a
   POST and an entry in the panel's store. The panel is what needs the library,
   and it is lazy (see `components/right-panel/sections.tsx`). */
import { describeError, reportError } from "@/lib/errors"
import { addTerminal, type Scope } from "@/lib/right-panel"
import { createTerminal, startHelperTerminal } from "@/lib/workspace/terminals"

/** Open a new shell in a scope's right panel. A thread's shell starts in its
    worktree and dies with the thread (`cwd`, `sessionId`). */
export async function openTerminal(
  scope: Scope,
  projectId: string,
  extra: { cwd?: string; sessionId?: string } = {}
): Promise<void> {
  try {
    const created = await createTerminal(projectId, extra)
    addTerminal(scope, { terminalId: created.id, projectId, ...extra })
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
 * draw a PTY in. Resolves true when the terminal started.
 */
export async function openHelperTerminal(
  scope: Scope,
  projectId: string,
  helper: { id: string; name: string }
): Promise<boolean> {
  try {
    const created = await startHelperTerminal(projectId, helper.id)
    /* Closed when the command finishes cleanly: a helper is an errand, and a
       shell left behind on every successful run is a row of dead shells to tidy
       by hand. A failure stays put, output and all. */
    addTerminal(scope, { terminalId: created.id, projectId, closeOnExit: true })
    return true
  } catch (err) {
    const { title } = describeError(err)
    reportError(err, title === "The request failed" ? `Couldn't run ${helper.name}` : undefined)
    return false
  }
}

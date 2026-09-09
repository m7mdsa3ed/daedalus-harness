/* What can happen to a thread that already exists: naming it, moving it to
   Trash and back, purging it, rolling it back and branching it.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import { uuid } from "../uuid"
import { api } from "../settings"
import { forgetDraft, patchDraft } from "../draft-sessions"
import { postJson, type ActionsCore } from "./core"

export function lifecycleActions(core: ActionsCore) {
  const { settings, dispatch, getState, threads, recordError, refreshSessions, reconnectThread } =
    core

  return {
    /** Name a thread by hand.
     *
     * A draft has no server row, so its name lives in the store until the
     * first message carries it into `POST /api/sessions` — which is why the
     * create call sends the title at all. For a started thread the server is
     * asked first and the store follows its answer, because the server is
     * what trims and caps it and a row saying something else is a list that
     * disagrees with the thread it names. */
    async renameThread(sessionId: string, title: string) {
      const next = title.trim()
      if (!next) return
      if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
        dispatch({ type: "rename-session", id: sessionId, title: next })
        patchDraft(settings.id, sessionId, { title: next })
        return
      }
      const { title: named } = await api<{ title: string }>(
        settings,
        `/api/sessions/${sessionId}`,
        { method: "PATCH", body: JSON.stringify({ title: next }) }
      )
      dispatch({ type: "rename-session", id: sessionId, title: named })
    },

    /** Reversible: the agent process dies, the thread moves to Trash.
        A draft has neither, and nothing to be restored from — closing it just
        forgets it. */
    async deleteThread(sessionId: string) {
      if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
        dispatch({ type: "drop-draft-session", id: sessionId })
        forgetDraft(settings.id, sessionId)
        return
      }
      threads.destroy(sessionId)
      await api(settings, `/api/sessions/${sessionId}`, { method: "DELETE" })
      await refreshSessions()
    },

    /** The same, for several at once — a project's list, where deleting the
        threads one row at a time is the operation nobody wants to perform
        twenty times. Sequential, because each DELETE stops a process, and one
        refresh at the end: the session list is the same read however many
        rows moved, and a refresh per thread would have them racing. A failure
        part way leaves the threads it already deleted deleted, which is what
        the caller's error report has to say. */
    async deleteThreads(sessionIds: string[]) {
      const drafts = new Set(
        getState()
          .sessions.filter((s) => s.draft)
          .map((s) => s.id)
      )
      try {
        for (const id of sessionIds) {
          if (drafts.has(id)) {
            dispatch({ type: "drop-draft-session", id })
            forgetDraft(settings.id, id)
            continue
          }
          threads.destroy(id)
          await api(settings, `/api/sessions/${id}`, { method: "DELETE" })
        }
      } finally {
        await refreshSessions()
      }
    },

    /** Back out of Trash. The thread returns process-less; opening it revives. */
    async restoreThread(sessionId: string) {
      await api(settings, `/api/sessions/${sessionId}/restore`, { method: "POST" })
      await refreshSessions()
    },

    /** The irreversible one — after this only the agent's own store has it. */
    async purgeThread(sessionId: string) {
      if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
        dispatch({ type: "drop-draft-session", id: sessionId })
        forgetDraft(settings.id, sessionId)
        return
      }
      threads.destroy(sessionId)
      await api(settings, `/api/sessions/${sessionId}?purge=1`, { method: "DELETE" })
      await refreshSessions()
    },

    /**
     * Roll the thread back to before `turnId`, discarding that turn and
     * everything after it. The server does fork, restore, respawn and
     * journal clear in one call, so a tab closing mid-rewind cannot leave a
     * half-rewound thread — and the journal ends up cleared and refilled
     * from the fork, so the caller reattaches from 0 exactly as it does
     * after a non-live config change (see `changeThreadConfig` in `config.ts`).
     *
     * - `conversation` = fork the agent session at the previous turn's last
     *   message and respawn onto it. Needs the agent's rewind door
     *   (`rewindVia`), otherwise the server answers 400.
     * - `files` = restore the worktree to the turn's start tree, leaving the
     *   transcript whole. Needs a file snapshot (404 without one).
     * - `both` = the usual pick: cut the conversation AND restore the files.
     *
     * Refusals land in the thread, next to the turn that asked: a running
     * turn is a 409 (cancel it first), a workflow step cannot be rewound at
     * all, and an unknown turn is a 404.
     */
    async rewindThread(
      sessionId: string,
      turnId: string,
      scope: "conversation" | "files" | "both"
    ): Promise<void> {
      try {
        await postJson(settings, `/api/sessions/${sessionId}/rewind`, { turnId, scope })
      } catch (error) {
        recordError(sessionId, error, "Couldn't rewind this thread")
        throw error
      }
      const listed = await refreshSessions()
      /* The journal was cleared under this socket, so the saved cursor is
         past the end of a log that has just started again — drop the socket
         and the cursor with it, exactly as the respawn tail above does, and
         rebuild from 0. */
      const conn = threads.for(sessionId)
      conn.forgetJournal()
      conn.markReviving()
      try {
        const rewound = listed.find((session) => session.id === sessionId)
        if (rewound) await conn.open(rewound, { revive: true })
        else await reconnectThread(sessionId)
      } catch (error) {
        recordError(sessionId, error, "Rewound, but the thread couldn't be reopened — revive it")
        throw error
      }
    },

    /** Branch the thread at a turn. The server cuts the conversation at that
        turn's own last message, loads the fork into a brand-new thread and
        leaves the parent exactly as it is — same process, same journal, same
        socket — so unlike a rewind there is no revive, no reattach and no
        cursor to drop. The id is minted here for the same reason
        `createSession` mints one: the route and the row exist before the
        round trip, and the caller can navigate on the answer. */
    async forkThread(sessionId: string, turnId: string): Promise<string> {
      const id = uuid()
      try {
        await postJson(settings, `/api/sessions/${sessionId}/fork`, { turnId, id })
      } catch (error) {
        recordError(sessionId, error, "Couldn't fork this thread")
        throw error
      }
      const listed = await refreshSessions()
      const forked = listed.find((session) => session.id === id)
      if (!forked) {
        throw new Error("The branch was created but never listed — reopen it from the sidebar.")
      }
      await threads.for(id).open(forked)
      return id
    },
  }
}

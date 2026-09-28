/* ── What a send is ──
   Everything that decides what Enter does with the box: the empty rule, the
   upload gate, the lock while a thread is on its way to existing, the three
   things a line can be instead of a prompt (an MCP prompt to render, a harness
   command, a `!` shell line), the `beforeSend` gate, the words carried back on
   a send that never left, and the history record once one did. */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"

import { harnessCommandFor } from "@/components/slash-commands"
import { shellLineFor } from "@/components/project-commands"
import type { DraftText } from "@/components/composer/use-draft-text"
import type { useComposerAttachments } from "@/hooks/use-composer-attachments"
import type { Actions } from "@/lib/actions"
import { clearDraft } from "@/lib/drafts"
import { reportError } from "@/lib/errors"
import { mcpPromptFor, renderMcpPrompt } from "@/lib/mcp-composer"
import { expandPastes } from "@/lib/pastes"
import { useInvalidateShellHistory, useRecordComposerHistory } from "@/lib/queries"
import { schedulePath } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import type { SessionMeta, ThreadMcpServer } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import type { holdOf } from "@/lib/thread/hold"
import type { composerLock } from "@/lib/thread/phase"

export function useComposerSend({
  sessionId,
  actions,
  thread,
  meta,
  draft,
  lock,
  hold,
  box,
  files,
  mcpServers,
  beforeSend,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
  draft: boolean
  lock: ReturnType<typeof composerLock>
  hold: ReturnType<typeof holdOf>
  box: DraftText
  files: ReturnType<typeof useComposerAttachments>
  mcpServers: ThreadMcpServer[]
  beforeSend?: (text: string) => Promise<boolean>
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const server = useServer()
  const recordHistory = useRecordComposerHistory()
  const invalidateShellHistory = useInvalidateShellHistory()
  /* `beforeSend` in flight: the box is taken, the button is busy. */
  const [gated, setGated] = React.useState(false)
  const { text, setText, textRef, pastes, setPastes } = box

  /* The schedule form, pre-filled — reached by `/schedule` typed into the box.
     The text goes expanded (the form stores it on the server, where the sidecar
     a token points into does not exist) and the draft is deliberately NOT
     cleared: nothing has been sent, and the form is a place you can back out of. */
  const openSchedule = (message: string) => {
    void navigate(schedulePath(sessionId), {
      state: {
        defaultText: expandPastes(message, pastes),
        returnTo: location.pathname + location.search,
      },
    })
  }

  /* A `!` line runs in the project and lands in the transcript as a
     `_daedalus/shell` row — no turn, no prompt. Which directory and environment
     is the server's call: a line that IS a saved helper runs as that helper.
     Send and forget, like a prompt: the running row is the feedback, and
     `runShell` settles it itself, failure included. */
  const runProjectCommand = (line: string) => {
    setText("")
    clearDraft(sessionId)
    void actions
      .runShell(sessionId, line)
      .catch((err) => reportError(err, `Couldn't run ${line}`))
      /* The server counted the run; this is the cache catching up so the next
         `!` has the line at the top. Whether it failed is not the tally's
         business — a line that failed is one you are about to run again. */
      .finally(() => {
        if (meta?.projectId) invalidateShellHistory(meta.projectId)
      })
  }

  const send = async (opts: { steer?: boolean } = {}) => {
    if (gated) return
    /* A held turn is stopped, not running — so Enter *steers* it rather than
       queueing behind a turn that never ends on its own. The steer chord still
       means what it always did; this only changes the plain send, and only
       while the turn is held. */
    const steering = opts.steer ?? hold.paused
    const value = text.trim()
    /* An image with no sentence is a real prompt; an upload still in flight is
       not — the prompt would name a row the server does not have yet. */
    if (!value && files.ready.length === 0) return
    if (files.uploading) return
    /* The thread is on its way to existing. The words stay in the box: a second
       Enter here used to POST the same session id twice and read the 409 as a
       failure to send the message that was already sending. */
    if (!lock.submittable) return
    /* An MCP prompt is rendered by its server and put in the box, not sent:
       the person reads the server's words before the agent does. */
    const mcpPrompt = draft ? null : mcpPromptFor(value, mcpServers, thread.availableCommands)
    if (mcpPrompt) {
      const what = `/${mcpPrompt.server.name}:${mcpPrompt.prompt.name}`
      void renderMcpPrompt(server, sessionId, mcpPrompt.server.id, mcpPrompt.prompt.name, mcpPrompt.args)
        .then((rendered) => {
          if (rendered) setText(rendered)
          else reportError(new Error("the prompt came back empty"), `Couldn't render ${what}`)
        })
        .catch((err) => reportError(err, `Couldn't render ${what}`))
      return
    }
    const command = draft ? null : harnessCommandFor(value, thread.availableCommands)
    if (command?.name === "schedule") {
      openSchedule(command.args)
      return
    }
    /* Gated on the capability, not the menu: a `/compact` typed in full on a
       runtime that does not take the request is sent as a prompt. */
    if (command?.name === "compact" && thread.canCompact) {
      setText("")
      clearDraft(sessionId)
      void actions.compact(sessionId)
      return
    }
    /* Only a started thread can take a `!` line: the result is journaled, and a
       draft has no row to journal into. */
    const line = draft ? null : shellLineFor(value)
    if (line) {
      runProjectCommand(line)
      return
    }
    /* Tokens become their bodies at the last moment; everything downstream sees
       the string it always did. */
    const outgoing = expandPastes(value, pastes)
    const attachments = files.ready.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
    /* What goes back in the box on a send that never leaves is what was
       typed, tokens and all. */
    const carriedPastes = pastes
    const carriedFiles = files.attachments
    box.reset()
    files.clear()
    /* A message that never reached the server comes back here, rather than
       surviving only on a `local` error row a reload deletes. Refused once the
       user has started typing again — that is a different message. */
    const onUnsent = () => {
      if (textRef.current.trim()) return false
      setText(value)
      setPastes(carriedPastes)
      files.restore(carriedFiles)
      return true
    }
    /* The gate runs with the box already cleared: what it does may navigate,
       and a composer mounting on the new route reads this device's draft
       storage, which must not still hold the words about to be sent. */
    if (beforeSend) {
      setGated(true)
      let ok = false
      try {
        ok = await beforeSend(value)
      } catch {
        ok = false
      } finally {
        setGated(false)
      }
      if (!ok) {
        onUnsent()
        return
      }
    }
    /* Recorded once the send has left, never before, and as *typed* (tokens,
       not bodies). Fire and forget: a history that did not record is not a
       send that failed. */
    void actions
      .send(sessionId, outgoing, { ...opts, steer: steering, attachments, onUnsent })
      .then(() => {
        if (value) recordHistory.mutate({ text: value, sessionId, threadTitle: meta?.title ?? null })
      })
      .catch(() => {})
  }

  return { send, gated }
}

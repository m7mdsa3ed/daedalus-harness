import * as React from "react"

import { captureError } from "@/lib/errors"
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  deleteAttachment,
  formatBytes,
  uploadAttachment,
} from "@/lib/attachments"
import {
  clearDraftAttachments,
  loadDraftAttachments,
  saveDraftAttachments,
  type DraftAttachment,
} from "@/lib/draft-attachments"
import { useServer } from "@/lib/server-context"
import { toast } from "@/lib/toast"
import { uuid } from "@/lib/uuid"

/**
 * What the composer is holding, and the uploads behind it.
 *
 * The id is minted here and the upload starts immediately, because an
 * attachment is uploaded **before the session exists**: threads start as drafts
 * and `POST /api/sessions` is deliberately not called until the first message,
 * so a route scoped to a session id would 404 on exactly the composer that
 * needs it most. The row is owned by nobody until the prompt that references it
 * claims it, and one that is never claimed is swept server-side after a day.
 *
 * A chip appears the moment a file is chosen, in an uploading state, so the
 * wait is visible where it is happening; a failure turns it into an error chip
 * with a retry rather than a toast the user has to connect back to a file. The
 * `File` is kept for exactly that retry — and the retry is usually a no-op on
 * the wire, since the upload is idempotent on content.
 *
 */
export function useComposerAttachments(sessionId: string) {
  const settings = useServer()
  const [attachments, setAttachments] = React.useState<DraftAttachment[]>(() =>
    loadDraftAttachments(sessionId)
  )
  React.useEffect(() => setAttachments(loadDraftAttachments(sessionId)), [sessionId])
  React.useEffect(() => saveDraftAttachments(sessionId, attachments), [sessionId, attachments])

  /** The bytes behind each chip, for a retry. Not state: nothing renders from
      it, and a `File` in state would be copied on every keystroke. */
  const files = React.useRef(new Map<string, File>())

  const patch = React.useCallback((id: string, next: Partial<DraftAttachment>) => {
    setAttachments((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, ...next } : entry))
    )
  }, [])

  const upload = React.useCallback(
    (id: string, file: File) => {
      patch(id, { status: "uploading", error: undefined })
      uploadAttachment(settings, id, file).then(
        (ref) => patch(id, { ...ref, status: "ready" }),
        (error: unknown) => {
          /* The chip is the surface: the user is looking at the thing they just
             dropped, and a toast in the corner is a card they have to connect
             back to a file. So this captures rather than reports — same
             normalizing, same console line, no second announcement. */
          const info = captureError(error, "Couldn't attach the file")
          if (info) patch(id, { status: "error", error: info.title })
        }
      )
    },
    [patch, settings]
  )

  /** Take on whatever was picked, dropped or pasted. Refusals are toasts, not
      chips: a file that was never accepted has no chip to put an error on. */
  const add = React.useCallback(
    (picked: Iterable<File>) => {
      const list = [...picked]
      if (list.length === 0) return
      setAttachments((prev) => {
        const room = MAX_ATTACHMENTS - prev.length
        if (room <= 0) {
          toast.error(`A message can carry ${MAX_ATTACHMENTS} attachments`)
          return prev
        }
        if (list.length > room) {
          toast.error(`Only ${room} more ${room === 1 ? "file fits" : "files fit"} on this message`)
        }
        const next: DraftAttachment[] = []
        for (const file of list.slice(0, room)) {
          if (file.size === 0) {
            toast.error(`${file.name} is empty`)
            continue
          }
          if (file.size > MAX_ATTACHMENT_BYTES) {
            toast.error(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}`)
            continue
          }
          const id = uuid()
          files.current.set(id, file)
          next.push({
            id,
            name: file.name || "file",
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            status: "uploading",
          })
        }
        /* Started outside the updater: it is a side effect, and React may run
           an updater twice. The chips it patches are the ones just added. */
        queueMicrotask(() => {
          for (const entry of next) {
            const file = files.current.get(entry.id)
            if (file) upload(entry.id, file)
          }
        })
        return next.length > 0 ? [...prev, ...next] : prev
      })
    },
    [upload]
  )

  const remove = React.useCallback((id: string) => {
    setAttachments((prev) => prev.filter((entry) => entry.id !== id))
    files.current.delete(id)
    /* Fire and forget, and 404 is fine: the row may never have been created
       (a failed upload), and one that exists but is never claimed is swept. */
    void deleteAttachment(settings, id).catch(() => {})
  }, [settings])

  const retry = React.useCallback(
    (id: string) => {
      const file = files.current.get(id)
      if (file) upload(id, file)
    },
    [upload]
  )

  /** Sent: the rows belong to the thread now, so nothing is deleted — only
      forgotten here. */
  const clear = React.useCallback(() => {
    setAttachments([])
    files.current.clear()
    clearDraftAttachments(sessionId)
  }, [sessionId])

  /** Put back what a send took, when that send never reached the server. Only
      into the empty composer it left behind: anything picked since belongs to
      the message the user is writing now, and that one wins. The rows are
      already uploaded and still theirs — nothing is re-sent to get them back. */
  const restore = React.useCallback((entries: DraftAttachment[]) => {
    if (entries.length === 0) return
    setAttachments((prev) => (prev.length > 0 ? prev : entries))
  }, [])

  /** Send is blocked while an upload is in flight: the prompt would name a row
      the server does not have yet, and a dropped attachment is a message that
      quietly says less than the user meant. */
  const uploading = attachments.some((entry) => entry.status === "uploading")
  const ready = React.useMemo(
    () => attachments.filter((entry) => entry.status === "ready"),
    [attachments]
  )

  return { attachments, ready, uploading, add, remove, retry, clear, restore }
}

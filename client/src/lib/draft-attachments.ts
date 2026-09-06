import type { AttachmentRef } from "@daedalus/protocol"

/* ── The composer's attachments ──
   What is attached to the message being written, per session, on this device —
   the third sidecar beside `drafts.ts` (the text) and `pastes.ts` (long pastes
   parked behind a token), and it joins their prune in `refreshSessions`.

   Only *uploaded* attachments are persisted, and they are persisted as
   references: the bytes are already on the server under a row of their own, so
   a reload gets its chips back by id and nothing is held in localStorage but a
   name and a size. An upload still in flight is not written down — it belongs
   to a page that is about to go away, and the row it would name may never
   exist. A row nothing ever claims is swept server-side after a day.

   No debounce, unlike the draft: this changes on a pick or a removal, not on
   every keystroke. */

/* Keyed by the session id, exactly as the draft and its pastes are — see
   lib/drafts. */
const PREFIX = "ui.draft-attachments."

const storageKey = (sessionId: string): string => PREFIX + sessionId

/** A chip in the composer. `status` is this device's view of the upload; only
    `ready` ones are persisted, and only `ready` ones may be sent. */
export interface DraftAttachment extends AttachmentRef {
  status: "uploading" | "ready" | "error"
  /** Why it failed, for the error chip's retry line. */
  error?: string
}

const isRef = (value: unknown): value is AttachmentRef =>
  !!value &&
  typeof value === "object" &&
  typeof (value as AttachmentRef).id === "string" &&
  typeof (value as AttachmentRef).name === "string"

export function loadDraftAttachments(key: string): DraftAttachment[] {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRef).map((ref) => ({
      id: ref.id,
      name: ref.name,
      mimeType: ref.mimeType ?? "application/octet-stream",
      size: ref.size ?? 0,
      status: "ready" as const,
    }))
  } catch {
    return []
  }
}

export function saveDraftAttachments(key: string, attachments: DraftAttachment[]): void {
  const ready = attachments
    .filter((entry) => entry.status === "ready")
    .map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
  try {
    if (ready.length > 0) localStorage.setItem(storageKey(key), JSON.stringify(ready))
    else localStorage.removeItem(storageKey(key))
  } catch {
    // A full or blocked storage costs the chip on the next load, never the
    // message: the row and its bytes are on the server either way.
  }
}

export function clearDraftAttachments(key: string): void {
  saveDraftAttachments(key, [])
}

/** Drop sidecars for sessions the server no longer lists — same contract as
    `pruneDrafts`. */
export function pruneDraftAttachments(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) && !live.has(key.slice(PREFIX.length))) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Nothing to prune if storage is unavailable.
  }
}

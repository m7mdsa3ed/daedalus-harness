/* ── What is in the box ──
   The words and the long pastes parked beside them, both persisted per session
   on this device (lib/drafts, lib/pastes). A paste is parked rather than pasted:
   a `[pasted text #n]` token stands in `text` and the body waits in the sidecar
   until send, where `expandPastes` puts it back. The sidecar is a second key,
   not a widened value, because every caller of `loadDraft` depends on it being
   a string. */
import * as React from "react"

import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
import { clearPastes, livePastes, loadPastes, savePastes, type Paste } from "@/lib/pastes"

export function useDraftText(sessionId: string) {
  const [text, setText] = React.useState(() => loadDraft(sessionId))
  /* The box as it is NOW, for the reader that runs long after the render it
     was written in: a send that fails asks whether the box is still the empty
     one it left behind before putting the words back. */
  const textRef = React.useRef(text)
  textRef.current = text
  React.useEffect(() => setText(loadDraft(sessionId)), [sessionId])
  React.useEffect(() => saveDraft(sessionId, text), [sessionId, text])

  const [pastes, setPastes] = React.useState<Paste[]>(() => loadPastes(sessionId))
  React.useEffect(() => setPastes(loadPastes(sessionId)), [sessionId])
  React.useEffect(() => savePastes(sessionId, pastes), [sessionId, pastes])
  /* A chip is a view of a token, so a token the user deleted drops its paste.
     Derived rather than pruned: pruning inside a render is a write during a
     render, and the persisted array is what a reload has to agree with. */
  const shownPastes = React.useMemo(() => livePastes(text, pastes), [text, pastes])

  /** Empty the box and the sidecar, persisted copies included — a draft
      cleared here and restored by a reload is a draft cleared twice. */
  const reset = React.useCallback(() => {
    setText("")
    setPastes([])
    clearDraft(sessionId)
    clearPastes(sessionId)
  }, [sessionId])

  return { text, setText, textRef, pastes, setPastes, shownPastes, reset }
}

export type DraftText = ReturnType<typeof useDraftText>

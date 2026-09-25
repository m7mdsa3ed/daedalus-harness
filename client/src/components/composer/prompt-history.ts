/* ── Prompt history ──
   Up recalls what you have already sent, the way a shell recalls a command.

   The history used to BE the transcript — every user turn of the thread you
   were standing in. That made it per-thread, which is the one thing a prompt
   history must not be: the hand that types is the same in every thread, and so
   is the phrase it keeps re-typing. It is the server's list now
   (`lib/composer-history.ts`), global across every thread and every device on
   this connection, oldest last exactly as before.

   Up still answers on the keystroke, because the list it walks is the query
   cache's — persisted to localStorage per server, so it is in hand before the
   first read lands — and a send patches that cache itself rather than waiting
   for a re-read. Walking back stashes whatever was half-typed; Escape, and
   walking forward off the end, put it back. */
import * as React from "react"

import type { ComposerHistoryEntry } from "@/lib/composer-history"
import { KEYS, matchesChord } from "@/lib/shortcuts"
import type { TextSurface } from "@/components/composer/composer-editor"

export function usePromptHistory(
  entries: ComposerHistoryEntry[],
  setText: (text: string) => void,
  inputRef: React.RefObject<TextSurface | null>
) {
  /* The server answers newest-first (the order the history page lists in) and
     the walk wants oldest-first, so Up from the bottom is the last thing sent.
     Keyed on the array identity the cache hands out, which only changes when
     the list actually does. */
  const history = React.useMemo(
    () => entries.map((entry) => entry.text).reverse(),
    [entries]
  )
  /** null = not browsing. Otherwise an index into `history`. */
  const [index, setIndex] = React.useState<number | null>(null)
  const stash = React.useRef("")

  // Sending (or a replay landing) changes the list under the cursor, so the
  // walk is over — the index would point at a different prompt than it did.
  React.useEffect(() => setIndex(null), [history.length])

  const apply = (el: TextSurface, value: string) => {
    setText(value)
    // The caret belongs at the end of the recalled prompt — after React has put
    // it in the DOM, which is the next frame.
    requestAnimationFrame(() => el.setSelectionRange(value.length, value.length))
  }

  /** True when it consumed the event, matching the slash menu's contract. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): boolean => {
    const el = inputRef.current
    if (!el) return false
    if (matchesChord(event, KEYS.escape)) {
      if (index === null) return false
      setIndex(null)
      apply(el, stash.current)
      /* Stop it reaching the thread's Escape, which would read this as "stop the
         turn" — leaving the history is the more local meaning and wins. */
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (history.length === 0) return false

    if (matchesChord(event, KEYS.historyPrev)) {
      /* Only from the very start of the box. Anywhere else Up is a caret move,
         which is what the key is for while editing a long prompt. */
      if (index === null && !(el.selectionStart === 0 && el.selectionEnd === 0)) return false
      const next = index === null ? history.length - 1 : index - 1
      event.preventDefault()
      // At the oldest prompt: stay there rather than falling out of the walk.
      if (next < 0) return true
      if (index === null) stash.current = el.value
      setIndex(next)
      apply(el, history[next])
      return true
    }

    if (matchesChord(event, KEYS.historyNext)) {
      if (index === null) return false
      event.preventDefault()
      const next = index + 1
      if (next >= history.length) {
        setIndex(null)
        apply(el, stash.current)
      } else {
        setIndex(next)
        apply(el, history[next])
      }
      return true
    }
    return false
  }

  return { onKeyDown, browsing: index !== null }
}

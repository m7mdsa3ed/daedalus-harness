/* ── What a drawn answer may ask of the thread holding it ──
   A generated view's one door back into the conversation. It is a context and
   not a store because it is a handle to *this thread's* composer: ThreadView
   owns one, and a view drawn anywhere else simply has none.

   The only thing behind it is `fill`, and its bargain is already the harness's:
   the words arrive in the box unsent, exactly as a suggested follow-up's and a
   `!` completer's do, so the reader reads them, edits if they want, and presses
   send. Nothing is ever sent from a view. */
import { createContext, useContext } from "react"

export type OpenuiActions = {
  /** Put words in the composer, unsent — the same bargain a suggestion pick makes. */
  fill: (text: string) => void
}

export const OpenuiActionsContext = createContext<OpenuiActions | null>(null)

export function useOpenuiActions(): OpenuiActions | null {
  return useContext(OpenuiActionsContext)
}

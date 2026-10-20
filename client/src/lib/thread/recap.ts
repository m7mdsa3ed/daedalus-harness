/* ── A short recap of the thread, for the composer's completion ──
 *
 * A fill-in-the-middle model is shown the text either side of the caret and
 * nothing else, which is enough to finish a command and not enough to finish a
 * *reply*: "does it work in" needs to know what the agent just said, or the
 * suggestion is a sentence with no subject. This is the smallest thing that
 * carries it — the last thing asked and the last thing answered — capped hard,
 * because it rides on a request made after every pause.
 *
 * What it is not: the transcript. No tool rows, no thoughts, no subagent items,
 * no attachments, and no history beyond one exchange. A completion is a
 * keystroke-scale request and this is a hint for it, not context engineering.
 */
import type { ThreadItem } from "@/lib/store/items"

/** The whole recap's ceiling. About 300 tokens: enough for the last exchange at
    the length people write them, small enough not to double the request. */
export const RECAP_CHARS = 1_200

/** The answer is what a reply is answering, so it gets the larger share. */
const ANSWER_CHARS = 700
const ASK_CHARS = 400

const tail = (text: string, max: number) => {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed
}

/** The last exchange as a few labelled lines, or "" on a thread with nothing in
    it yet (a draft, a fresh aside, a thread whose only rows are tools). */
export function threadRecap(items: readonly ThreadItem[]): string {
  let asked = ""
  let answered = ""
  /* Backwards, because the last of each is the one being replied to, and the
     stop is early: a long transcript costs nothing to walk past twice. */
  for (let i = items.length - 1; i >= 0 && (!asked || !answered); i -= 1) {
    const item = items[i]
    if (!item || item.kind === "tool" || item.kind === "thought" || item.kind === "notice") continue
    /* A subagent's item is not this thread's conversation. */
    if ("parentId" in item && item.parentId) continue
    if (item.kind === "agent" && !answered) answered = tail(item.text, ANSWER_CHARS)
    if (item.kind === "user" && !asked) asked = tail(item.text, ASK_CHARS)
  }
  const lines = [asked && `User: ${asked}`, answered && `Assistant: ${answered}`].filter(Boolean)
  return lines.join("\n").slice(0, RECAP_CHARS)
}

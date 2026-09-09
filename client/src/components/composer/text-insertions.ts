/* ── Typing on the user's behalf ──
   Everything the "+" menu puts into the box, and the caret rule they all
   share. Plain closures over the box's state rather than a hook: there is no
   state of its own here, only three edits and the one place the caret is
   re-applied from. */
import type * as React from "react"

/** Where the caret is, or the end of the text when the box is not mounted. */
export function selectionOf(el: HTMLTextAreaElement | null, fallback: number): [number, number] {
  const start = el?.selectionStart ?? fallback
  const end = el?.selectionEnd ?? start
  return [start, end]
}

export function textInsertions({
  text,
  setText,
  requestCaret,
  inputRef,
}: {
  text: string
  setText: (value: string) => void
  /** The `@` completer's caret slot — see `insert` below for why it is that
      hook's and not a second mechanism racing it. */
  requestCaret: (at: number) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  /* Typing on the user's behalf. Every insertion the "+" menu makes goes
     through here so the caret lands where a typist's would — after the
     snippet, or inside it when `caretAt` says so — by the same slot the `@`
     completer uses (`requestCaret`), because rewriting `text` is a render and
     the caret must be re-applied after it. Focus comes back on the next frame:
     the menu that was clicked took it, and a snippet with no caret to follow
     it is a snippet the user has to click back into. */
  const insert = (snippet: string, caretAt?: number) => {
    const el = inputRef.current
    const [start, end] = selectionOf(el, text.length)
    setText(text.slice(0, start) + snippet + text.slice(end))
    requestCaret(start + (caretAt ?? snippet.length))
    requestAnimationFrame(() => el?.focus())
  }
  const insertMention = () => {
    const el = inputRef.current
    const [start] = selectionOf(el, text.length)
    const before = text.slice(0, start)
    // A mention is a word: it needs a space before it unless it starts a line.
    insert(before === "" || /\s$/.test(before) ? "@" : " @")
  }
  /* A command is the start of the message, not a word in it: the completer
     reads `^/name`, so the slash goes to the front wherever the caret was. */
  const insertCommand = () => {
    if (text.startsWith("/")) {
      inputRef.current?.focus()
      return
    }
    setText("/" + text)
    requestCaret(1)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  /* Fences around the selection, or an empty block with the caret inside. On
     its own line either way: a fence mid-sentence is not a fence. */
  const insertCodeBlock = () => {
    const el = inputRef.current
    const [start, end] = selectionOf(el, text.length)
    const selected = text.slice(start, end)
    const before = text.slice(0, start)
    const lead = before === "" || before.endsWith("\n") ? "" : "\n"
    const open = `${lead}\`\`\`\n`
    const snippet = `${open}${selected}\n\`\`\`\n`
    setText(before + snippet + text.slice(end))
    requestCaret(start + open.length + selected.length)
    requestAnimationFrame(() => el?.focus())
  }

  return { insertMention, insertCommand, insertCodeBlock }
}

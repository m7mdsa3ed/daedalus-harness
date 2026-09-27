export interface OpenuiFence {
  start: number
  end: number
  code: string
  open: boolean
}

/* Closed first: each completed fence is paired with its own terminator, which
   matters when a message contains more than one. */
const CLOSED_RE =
  /(^|\n)[ \t]*```+[ \t]*(?:openui(?:-lang)?|ui-lang)[ \t]*\r?\n([\s\S]*?)```+[ \t]*(?=\n|$)/g

/* A trailing fence is a program in progress only while the row is streaming. */
const OPEN_RE = /(^|\n)[ \t]*```+[ \t]*(?:openui(?:-lang)?|ui-lang)[ \t]*\r?\n([\s\S]*)$/

/** Split prose from OpenUI fences, including a trailing open fence while streaming. */
export function splitOpenuiFences(text: string, streaming: boolean): (string | OpenuiFence)[] {
  const parts: (string | OpenuiFence)[] = []
  let cut = 0
  for (const match of text.matchAll(CLOSED_RE)) {
    const start = match.index + match[1].length
    const end = start + match[0].length - match[1].length
    if (start > cut) parts.push(text.slice(cut, start))
    parts.push({ start, end, code: match[2], open: false })
    cut = end
  }
  const rest = text.slice(cut)
  const pending = streaming ? OPEN_RE.exec(rest) : null
  if (pending) {
    const start = cut + pending.index + pending[1].length
    if (start > cut) parts.push(text.slice(cut, start))
    parts.push({ start, end: text.length, code: pending[2], open: true })
  } else if (rest) {
    parts.push(rest)
  }
  return parts
}

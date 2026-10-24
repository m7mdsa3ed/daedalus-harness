/* ── `@kind:ref` mention context ──
   A typed mention reaches the agent as the thing it names: at send, the
   composer asks the server for a `<context>` block (`server/src/mentions/expand.ts`)
   and appends it after the message — and after a `<tasks>` block when there is
   one. The bubble folds the block back out (`splitMentionContext`) and hangs
   each mention's body on its chip as a popover, so the transcript keeps exactly
   what the agent was sent and still reads as what was typed.

   Gated on the server's `mentionKinds` feature: an older server has no route,
   and the message goes as typed. */
import { api, type ServerSettings } from "@/lib/settings"
import { splitTaskContext } from "@/lib/task-mentions"
import { hasKindMention } from "./grammar"

const OPEN = "<context>\n"
const CLOSE = "</context>"

/** The attribute escapes `attr` writes on the server. */
const unattr = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

/**
 * A sent message, split into what was typed and the context block appended to
 * it: each mention's body keyed by `kind:ref`. Only a *trailing* block counts —
 * a `<context>` inside what was typed is words.
 */
export function splitMentionContext(text: string): { text: string; mentions: Map<string, string> } {
  const mentions = new Map<string, string>()
  const end = text.trimEnd()
  const at = end.lastIndexOf(OPEN)
  if (at < 0 || !end.endsWith(CLOSE)) return { text, mentions }
  for (const match of end.slice(at).matchAll(/<mention kind="([^"]+)" ref="([^"]*)">\n([\s\S]*?)\n<\/mention>/g)) {
    mentions.set(`${match[1]}:${unattr(match[2])}`, match[3])
  }
  if (mentions.size === 0) return { text, mentions }
  return { text: end.slice(0, at).trimEnd(), mentions }
}

/** Both trailing blocks, in either order: the typed text, each task's part
    (keyed `KEY-12`) and each mention's (keyed `kind:ref`). */
export function splitSentContext(text: string): {
  text: string
  tasks: Map<string, string>
  mentions: Map<string, string>
} {
  const tasks = new Map<string, string>()
  const mentions = new Map<string, string>()
  let rest = text
  for (;;) {
    const m = splitMentionContext(rest)
    if (m.mentions.size > 0) {
      for (const [key, body] of m.mentions) if (!mentions.has(key)) mentions.set(key, body)
      rest = m.text
      continue
    }
    const t = splitTaskContext(rest)
    if (t.tasks.size > 0) {
      for (const [key, body] of t.tasks) if (!tasks.has(key)) tasks.set(key, body)
      rest = t.text
      continue
    }
    return { text: rest, tasks, mentions }
  }
}

/** `text` with the `<context>` block for every `@kind:ref` it mentions
    appended, at send. A message that already carries one — recalled from
    history — is given a fresh one, never a second. The caller has checked the
    server's `mentionKinds` feature. */
export async function withMentionContext(
  settings: ServerSettings,
  text: string,
  scope: { projectId: string; sessionId?: string },
): Promise<string> {
  const typed = splitMentionContext(text).text
  if (!hasKindMention(typed)) return typed
  const out = await api<{ text: string }>(settings, "/api/mentions/context", {
    method: "POST",
    body: JSON.stringify({ text: typed, projectId: scope.projectId, sessionId: scope.sessionId }),
  })
  return typed + out.text
}

/* ── `@KEY-12` task mentions ──
   A task mentioned in a message goes to the agent as the task itself: at send,
   the composer asks the server for a `<tasks>` block (`server/src/task-mentions.ts`)
   and appends it, the way a long paste is expanded into its fence. The bubble
   folds the block back out (`splitTaskContext`) and hangs each task's part on
   its `@KEY-12` chip as a popover — so the transcript keeps exactly what the
   agent was sent, and still reads as what was typed.

   Only for a thread that carries the Harness MCP: the block tells the agent to
   work the task through it. */

/** The library row the block tells the agent to call. */
export const HARNESS_MCP_ID = "builtin:harness"

/** A board key and number, as the chip and the server read it. */
export const TASK_KEY = /^[A-Z][A-Z0-9]{1,5}-\d+$/

/** `@KEY-12` anywhere in a message, after a boundary. */
export const TASK_MENTION_RE = /(?:^|[\s(])@[A-Z][A-Z0-9]{1,5}-\d+/

const OPEN = "<tasks>\n"
const CLOSE = "</tasks>"

/**
 * A sent message, split into what was typed and the task block appended to it:
 * each task's part keyed by its key. The block is always the message's tail,
 * so only a trailing one counts — a `<tasks>` inside what was typed is words.
 */
export function splitTaskContext(text: string): { text: string; tasks: Map<string, string> } {
  const tasks = new Map<string, string>()
  const end = text.trimEnd()
  const at = end.lastIndexOf(OPEN)
  if (at < 0 || !end.endsWith(CLOSE)) return { text, tasks }
  for (const match of end.slice(at).matchAll(/<task key="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/task>/g)) {
    tasks.set(match[1], match[2])
  }
  if (tasks.size === 0) return { text, tasks }
  return { text: end.slice(0, at).trimEnd(), tasks }
}

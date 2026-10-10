/* ── Follow-up prompt suggestions ──
   When a thread's suggestions toggle is on, the spawn instructions ask the
   model to close each answer with 2–3 follow-up prompts in one fenced block
   (`server/src/personas.ts`). This module is the client half: parse those
   prompts out of the transcript, hide the fence where the answer is painted,
   and offer the prompts as a card under the very answer that suggested them
   (`prompt-suggestions.tsx`).

   The fence name is deliberately distinctive so a real code block is never
   mistaken for suggestions — the match requires the exact info string. */
import type { ThreadItem } from "./store"

/** Painted on the answer that offered them: a snap-scrolling stack of cards
    (`prompt-suggestions.tsx`), each one a follow-up. */

/** Fence the model wraps follow-up prompts in. Mirrored server-side (`personas.ts`). */
export const SUGGEST_PROMPTS_FENCE = "suggest-prompts"

/** Fence the model wraps recommended project commands in. Mirrored server-side
    (`personas.ts`) — a second fence, because the two are drawn and acted on
    differently: a follow-up is a sentence filled into the box, a command is a
    `!` line the send path runs against the project. */
export const SUGGEST_COMMANDS_FENCE = "suggest-commands"

const FENCE_RE = /```suggest-prompts[^\S\r\n]*\r?\n([\s\S]*?)```/g
const COMMANDS_FENCE_RE = /```suggest-commands[^\S\r\n]*\r?\n([\s\S]*?)```/g

/** Every follow-up prompt in `text`, in order. Empty when there is no block. */
export function parsePromptSuggestions(text: string): string[] {
  if (!text || text.indexOf(SUGGEST_PROMPTS_FENCE) === -1) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(FENCE_RE)) {
    for (const line of match[1].split("\n")) {
      const prompt = line.trim()
      // Skip blanks and fence-internal scaffolding; cap the length so one
      // runaway line cannot stretch the chip row off the panel.
      if (!prompt || prompt.length < 2 || prompt.length > 280) continue
      if (/^[`<]+$/.test(prompt)) continue
      const key = prompt.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(prompt)
      // The trailer asks for 2–3; accept one extra rather than drop a good one.
      if (out.length >= 4) return out
    }
  }
  return out
}

/** Every recommended project command in `text`, in order, capped at two — the
    trailer asks for one or two, and a third is noise beside a follow-up list.
    The lines are *unnormalised*: whether one names a command the project
    defines is `keepDefinedCommands`'s question, not the parser's. */
export function parseCommandSuggestions(text: string): string[] {
  if (!text || text.indexOf(SUGGEST_COMMANDS_FENCE) === -1) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(COMMANDS_FENCE_RE)) {
    for (const line of match[1].split("\n")) {
      const command = line.trim()
      // Skip blanks and fence-internal scaffolding; cap the length so one
      // runaway line cannot stretch the row off the panel.
      if (!command || command.length > 320) continue
      if (/^[`<]+$/.test(command)) continue
      if (seen.has(command)) continue
      seen.add(command)
      out.push(command)
      if (out.length >= 2) return out
    }
  }
  return out
}

/** `text` with every suggestions block removed, for painting the answer. The
    raw message is untouched everywhere else — copy, search and the journal
    still read the whole thing (`thread-items/rows.tsx` paints, never rewrites). */
export function stripPromptSuggestions(text: string): string {
  if (!text || text.indexOf(SUGGEST_PROMPTS_FENCE) === -1) return text
  return text
    .replace(FENCE_RE, "")
    .replace(COMMANDS_FENCE_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
}

/** A turn's suggestion card: the last top-level agent message that carries a
    fence — follow-up prompts, recommended commands, or both — and what it
    carried. The anchor the transcript hangs the card off.
    A subagent's prose (`parentId`) is skipped: the trailer is the thread's own
    answer's convention, and a worker's messages are the work, not the answer.
    One agent message per turn carries the blocks, so the walk stops at the
    first one that has either; a turn whose answers carry none offers nothing,
    however earlier turns ended. */
export function turnSuggestions(
  turn: readonly ThreadItem[]
): { itemId: string; prompts: string[]; commands: string[] } | undefined {
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i]
    if (item.kind !== "agent" || item.parentId) continue
    const prompts = parsePromptSuggestions(item.text)
    const commands = parseCommandSuggestions(item.text)
    if (prompts.length > 0 || commands.length > 0) return { itemId: item.id, prompts, commands }
  }
  return undefined
}

/** The recommended commands that name one the project actually defines, deduped
    and capped at two. The model is handed the project's list and told to name
    only from it; this is the read that makes it true regardless — a line that
    resolves to nothing is dropped rather than drawn as a command that would
    fail the moment it ran. */
export function keepDefinedCommands(
  commands: readonly string[],
  defined: ReadonlySet<string>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of commands) {
    const command = raw.trim()
    if (!command || seen.has(command) || !defined.has(command)) continue
    seen.add(command)
    out.push(command)
    if (out.length >= 2) break
  }
  return out
}
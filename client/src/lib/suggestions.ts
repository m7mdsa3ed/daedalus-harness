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

const FENCE_RE = /```suggest-prompts[^\S\r\n]*\r?\n([\s\S]*?)```/g

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

/** `text` with every suggestions block removed, for painting the answer. The
    raw message is untouched everywhere else — copy, search and the journal
    still read the whole thing (`thread-items.tsx` paints, never rewrites). */
export function stripPromptSuggestions(text: string): string {
  if (!text || text.indexOf(SUGGEST_PROMPTS_FENCE) === -1) return text
  return text
    .replace(FENCE_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
}

/** A turn's suggestion card: the last top-level agent message that carries a
    fence, and its prompts — the anchor the transcript hangs the card off.
    A subagent's prose (`parentId`) is skipped: the follow-up trailer is the
    thread's own answer's convention, and a worker's messages are the work,
    not the answer. One agent message per turn carries the block, so the walk
    stops at the first one that has it; a turn whose answers carry none offers
    nothing, however earlier turns ended. */
export function turnSuggestions(
  turn: readonly ThreadItem[]
): { itemId: string; prompts: string[] } | undefined {
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i]
    if (item.kind !== "agent" || item.parentId) continue
    const prompts = parsePromptSuggestions(item.text)
    if (prompts.length > 0) return { itemId: item.id, prompts }
  }
  return undefined
}
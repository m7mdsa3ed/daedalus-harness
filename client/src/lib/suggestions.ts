/* ── Closing suggestions ──
   When a thread asks for them, the spawn instructions have the model close
   each answer with fenced blocks — follow-up prompts, project commands, quick
   replies, files, other agents to ask (`server/src/personas.ts`). This module
   is the client half, and it is one table: a kind is an entry in
   `SUGGEST_KINDS`, and the parser, the strip that hides the fences, the card
   under the answer (`suggestion-group.tsx`) and the picker all read it. Adding
   a kind is an entry here and its twin in `personas.ts` — nothing else
   branches on a kind's name.

   Each fence name is deliberately distinctive so a real code block is never
   mistaken for a suggestion — the match requires the exact info string. */
import {
  ArrowUpRightIcon,
  BotIcon,
  FileTextIcon,
  ReplyIcon,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"

import type { ThreadItem } from "./store"

/** What a kind's `keep` is asked with: facts only the thread view knows. */
export interface SuggestCtx {
  /** The commands the thread's project defines (`!` completer's union). */
  definedCommands: ReadonlySet<string>
}

export interface SuggestKindDef {
  id: string
  /** The picker's row, and what it does in a sentence. */
  label: string
  description: string
  /** The card's caption over its rows. */
  caption: string
  icon: LucideIcon
  /** Fence the model wraps this kind in. Mirrored server-side (`personas.ts`). */
  fence: string
  /** Rows kept per answer, and the longest line accepted. */
  max: number
  maxLen: number
  /** Shell dress: the recessed ground, monospace, a single line. */
  mono?: boolean
  /** The words a pick puts in the composer. Filled, never sent: what goes out
      is worth reading and editing first. */
  fill: (line: string) => string
  /** What the row says, when that is not the line itself. */
  show?: (line: string) => string
  /** Drops lines that name nothing real (a command the project lacks). */
  keep?: (lines: readonly string[], ctx: SuggestCtx) => string[]
}

/** `agent | task` — the one line the agents kind carries. */
const splitAsk = (line: string): [string, string] | undefined => {
  const at = line.indexOf("|")
  if (at < 1) return undefined
  const agent = line.slice(0, at).trim()
  const task = line.slice(at + 1).trim()
  return agent && task ? [agent, task] : undefined
}

/** In the picker's order; the first kind is the server's last trailer. */
export const SUGGEST_KINDS: readonly SuggestKindDef[] = [
  {
    id: "prompts",
    label: "Follow-up prompts",
    description: "Next messages you might send",
    caption: "Next",
    icon: ArrowUpRightIcon,
    fence: "suggest-prompts",
    max: 4,
    maxLen: 280,
    fill: (line) => line,
  },
  {
    id: "commands",
    label: "Project commands",
    description: "Helpers and scripts worth running next",
    caption: "Project commands",
    icon: SquareTerminal,
    fence: "suggest-commands",
    max: 2,
    maxLen: 320,
    mono: true,
    fill: (line) => `!${line}`,
    show: (line) => `!${line}`,
    /* The model is handed the project's list and told to name only from it;
       this read makes it true regardless — a line that resolves to nothing is
       dropped rather than drawn as a command that would fail when it ran. */
    keep: (lines, ctx) => lines.filter((line) => ctx.definedCommands.has(line.trim())),
  },
  {
    id: "replies",
    label: "Quick replies",
    description: "Short answers when the agent asks you something",
    caption: "Reply",
    icon: ReplyIcon,
    fence: "suggest-replies",
    max: 4,
    maxLen: 80,
    fill: (line) => line,
  },
  {
    id: "files",
    label: "Files",
    description: "Files the answer is about, as @ mentions",
    caption: "Files",
    icon: FileTextIcon,
    fence: "suggest-files",
    max: 3,
    maxLen: 200,
    mono: true,
    fill: (line) => `@${line} `,
    show: (line) => line,
  },
  {
    id: "agents",
    label: "Ask another agent",
    description: "A second opinion from another profile and agent",
    caption: "Ask another agent",
    icon: BotIcon,
    fence: "suggest-agents",
    max: 2,
    maxLen: 200,
    /* Naming the pair in the message is what lets the `agent` tool run without
       stopping to ask which profile to use. */
    fill: (line) => {
      const ask = splitAsk(line)
      return ask ? `Ask ${ask[0]} to ${ask[1]}` : line
    },
    show: (line) => {
      const ask = splitAsk(line)
      return ask ? `${ask[0]}: ${ask[1]}` : line
    },
    keep: (lines) => lines.filter((line) => splitAsk(line)),
  },
]

export const SUGGEST_KIND_IDS = SUGGEST_KINDS.map((kind) => kind.id)

/** What a thread that never picked asks for — the old toggle's "on". Mirrored
    by the server (`DEFAULT_SUGGEST_KINDS`). */
export const DEFAULT_SUGGEST_KINDS: readonly string[] = ["prompts", "commands"]

/** A set cut to known ids, in picker order. */
export function normalizeSuggestKinds(kinds: readonly string[] | undefined | null): string[] {
  const asked = new Set(kinds ?? [])
  return SUGGEST_KIND_IDS.filter((id) => asked.has(id))
}

const fenceRe = new Map<string, RegExp>()
const fenceOf = (def: SuggestKindDef): RegExp => {
  let re = fenceRe.get(def.id)
  if (!re) {
    re = new RegExp("```" + def.fence + "[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)```", "g")
    fenceRe.set(def.id, re)
  }
  return re
}

/** Every line of `def`'s fence in `text`, in order, deduped and capped. Lines
    are *unnormalised* by `keep` — whether one names something real is the
    caller's question, not the parser's. */
export function parseSuggestions(text: string, def: SuggestKindDef): string[] {
  if (!text || text.indexOf(def.fence) === -1) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(fenceOf(def))) {
    for (const raw of match[1].split("\n")) {
      const line = raw.trim()
      // Skip blanks and fence-internal scaffolding; the cap stops one runaway
      // line stretching the row off the panel.
      if (!line || line.length < 2 || line.length > def.maxLen) continue
      if (/^[`<]+$/.test(line)) continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
      if (out.length >= def.max) return out
    }
  }
  return out
}

/** `text` with every suggestions block removed, for painting the answer. The
    raw message is untouched everywhere else — copy, search and the journal
    still read the whole thing (`thread-items/rows.tsx` paints, never rewrites).
    Strips every kind whether or not the thread has it on: a fence that arrives
    anyway is still not something to paint raw. */
export function stripPromptSuggestions(text: string): string {
  if (!text || text.indexOf("```suggest-") === -1) return text
  let out = text
  for (const def of SUGGEST_KINDS) out = out.replace(fenceOf(def), "")
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")
}

/** One kind's rows under an answer. */
export interface SuggestGroup {
  kind: SuggestKindDef
  lines: string[]
}

/** A turn's suggestion card: the last top-level agent message that carries any
    enabled kind's fence, and what it carried. The anchor the transcript hangs
    the card off. A subagent's prose (`parentId`) is skipped: the trailer is the
    thread's own answer's convention, and a worker's messages are the work, not
    the answer. One agent message per turn carries the blocks, so the walk stops
    at the first that has any; a turn whose answers carry none offers nothing,
    however earlier turns ended. `keep` has run, so every row is real. */
export function turnSuggestions(
  turn: readonly ThreadItem[],
  enabled: readonly string[],
  ctx: SuggestCtx
): { itemId: string; groups: SuggestGroup[] } | undefined {
  const kinds = SUGGEST_KINDS.filter((kind) => enabled.includes(kind.id))
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i]
    if (item.kind !== "agent" || item.parentId) continue
    const groups: SuggestGroup[] = []
    for (const kind of kinds) {
      const parsed = parseSuggestions(item.text, kind)
      const lines = (kind.keep ? kind.keep(parsed, ctx) : parsed).slice(0, kind.max)
      if (lines.length > 0) groups.push({ kind, lines })
    }
    if (groups.length > 0) return { itemId: item.id, groups }
  }
  return undefined
}

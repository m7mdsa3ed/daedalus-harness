/* ── The streaming reveal ──
   The pacer (`hooks/use-streamed-text`) decides *when* each word of a live turn
   appears; this decides what appearing looks like. It is one rehype pass and a
   handful of CSS rules in `index.css`, picked between by the `streamEffect`
   view option.

   The two families of effect want different things from the pass, and `tail`
   is which:

   • **Per-word animations** (`blur`, `rise`, `fade`, `pop`) need nothing but
     the span, because a
     span exists only once its word does: the animation runs exactly once, on
     arrival, and nothing has to remember how far the reveal has got — no state,
     no replay bookkeeping, nothing to reset on a re-fold. What they *do* need is
     for every word to be wrapped, and that is not an aesthetic choice. Markdown
     children arrive unkeyed, so React reconciles them by position; a fixed-size
     window of spans is the same eight positions on every render, so the newest
     word lands in a span that already exists, its text is patched, and nothing
     mounts. Growing the node set is the only thing that makes a mount animation
     mount, and it is the cost of this family.
   • **The edge family** (`sweep`, `trail`, `warm`, `caret`) asks the opposite
     question — how far is this word from the edge — so the softness is a property of *position* and travels forward as
     words arrive, with nothing to play and nothing to finish. That makes the
     window not just possible but right: only the last `TAIL_WORDS` words are
     wrapped, `--tail` (0 = newest) is stamped on them, the ramp is CSS's, and
     the transition on the derived opacity/filter is what turns a discrete shift
     into a moving edge. Words behind the ramp are already at rest, so they get
     no node at all — a word leaves by having its span unmounted and its text
     folded back into the plain text node in front of it, which is invisible
     precisely because the ramp ends on the resting appearance. It is the cheap
     one, in the diff (a 900-word answer stays a text node plus eight spans,
     re-rendered per word) and in the paint (a `filter` is a compositing layer,
     and only eight words ever carry one).

   `pre`/`code` subtrees are skipped in both cases: a fence completing rewrites
   that whole subtree, so every token in it would remount and the block would
   flash as one — and rehype-highlight has already split it into spans that mean
   something else. */

import type * as React from "react"

/** Effects offered by the `streamEffect` view option. Declared here, next to
 *  the pass that implements them, so a new one is a value, a CSS block and a
 *  row in `STREAM_EFFECTS` — the picker and the store both read this table. */
export type StreamEffect =
  | "sweep"
  | "trail"
  | "warm"
  | "caret"
  | "blur"
  | "rise"
  | "fade"
  | "pop"
  | "none"

/** Which mechanism an effect is built on — which is also the whole of what the
 *  pass needs to know, and the honest way to group them in the picker. */
export type StreamFamily = "edge" | "word"

export const STREAM_EFFECTS: {
  id: StreamEffect
  family: StreamFamily
  label: string
  description: string
}[] = [
  {
    id: "sweep",
    family: "edge",
    label: "Sweep",
    description: "A soft edge sits over the newest words and travels forward as the answer is written.",
  },
  {
    id: "trail",
    family: "edge",
    label: "Trail",
    description:
      "The same travelling edge in light alone, with no blur — the cheapest of these to draw, and the one to reach for on a tired machine.",
  },
  {
    id: "warm",
    family: "edge",
    label: "Warm",
    description: "The newest words arrive in the accent colour and cool into the text behind them.",
  },
  {
    id: "caret",
    family: "edge",
    label: "Caret",
    description: "A cursor follows the last word written. Nothing fades — the caret is the whole signal.",
  },
  {
    id: "blur",
    family: "word",
    label: "Resolve",
    description: "Each word arrives out of a small blur, on its own clock.",
  },
  {
    id: "rise",
    family: "word",
    label: "Rise",
    description: "Each word lifts a little as it resolves.",
  },
  {
    id: "fade",
    family: "word",
    label: "Fade",
    description: "Each word simply fades up. The quietest thing that is still an arrival.",
  },
  {
    id: "pop",
    family: "word",
    label: "Pop",
    description: "Each word resolves while growing the last few percent into place.",
  },
  {
    id: "none",
    family: "word",
    label: "None",
    description: "Words appear as they arrive, with nothing added. The pacing itself is unchanged.",
  },
]

const IDS = new Set<string>(STREAM_EFFECTS.map((effect) => effect.id))

const EDGE = new Set<string>(
  STREAM_EFFECTS.filter((effect) => effect.family === "edge").map((effect) => effect.id)
)

/** Does this effect need each span stamped with its distance from the newest
 *  word? True for the whole edge family and nothing else — see the note at the
 *  top for why that is also what decides how many words get wrapped. */
export function needsTail(effect: StreamEffect | undefined): boolean {
  return effect !== undefined && EDGE.has(effect)
}

export function isStreamEffect(value: unknown): value is StreamEffect {
  return typeof value === "string" && IDS.has(value)
}

/** The sweep's gradient length, in words. Mirrored by `--stream-ramp` in
 *  index.css, which is what divides `--tail` back down into a 0…1 position, so
 *  the two have to move together. */
export const TAIL_WORDS = 8

/** Minimal hast, spelled locally: the pass touches four fields, and taking a
 *  dependency on `@types/hast` for them would be the larger commitment. */
interface Node {
  type: string
  tagName?: string
  value?: string
  children?: Node[]
  properties?: Record<string, unknown>
}

/** Subtrees whose text is not prose being written a word at a time. */
const SKIP = new Set(["pre", "code"])

/** Words and the whitespace between them, kept apart: a span per space would
 *  double the node count for nothing, and whitespace collapsing around an
 *  inline box is subtler than it looks. */
const TOKENS = /\S+|\s+/g

interface Slot {
  parent: Node
  index: number
  value: string
}

/** Every text node that is prose, in document order. */
function collect(node: Node, out: Slot[]): void {
  const children = node.children
  if (!children) return
  if (node.tagName && SKIP.has(node.tagName)) return
  children.forEach((child, index) => {
    if (child.type === "text") {
      if (child.value) out.push({ parent: node, index, value: child.value })
    } else {
      collect(child, out)
    }
  })
}

const wordSpan = (word: string, tail: number | null): Node => ({
  type: "element",
  tagName: "span",
  properties: {
    className: ["t-stream-w"],
    // Only under `sweep`: the attribute is what the CSS matches on, so the
    // words behind the ramp carry no filter and no transition at all.
    /* Both, and they are not redundant: `--tail` is what CSS divides down into
       a 0…1 position, and the attribute *value* is what a selector can match on
       — which is how `caret` finds the one word at the edge. */
    ...(tail === null ? {} : { "data-tail": String(tail), style: `--tail:${tail}` }),
  },
  children: [{ type: "text", value: word }],
})

/**
 * Wrap words from the end of the tree backwards — the last `TAIL_WORDS` of them
 * under the sweep, all of them otherwise (see the note on mounting above).
 *
 * Slots are rewritten back to front, which is also why the recorded indices stay
 * valid: splicing a later slot cannot move an earlier one, even when both sit in
 * the same parent.
 */
function wrapTail(tree: Node, tail: boolean): void {
  const slots: Slot[] = []
  collect(tree, slots)

  const budget = tail ? TAIL_WORDS : Infinity
  let taken = 0
  for (let s = slots.length - 1; s >= 0 && taken < budget; s--) {
    const slot = slots[s]!
    const tokens = [...slot.value.matchAll(TOKENS)].map(([token]) => token)
    const replacement: Node[] = []
    let cut = tokens.length

    for (let t = tokens.length - 1; t >= 0; t--) {
      const token = tokens[t]!
      if (/^\s/.test(token)) {
        replacement.unshift({ type: "text", value: token })
      } else {
        if (taken >= budget) break
        replacement.unshift(wordSpan(token, tail ? taken : null))
        taken++
      }
      cut = t
    }

    // Everything the budget did not reach stays one plain text node, so the
    // body of a long message is never split into nodes at all.
    if (cut > 0) replacement.unshift({ type: "text", value: tokens.slice(0, cut).join("") })
    slot.parent.children!.splice(slot.index, 1, ...replacement)
  }
}

/**
 * Rehype plugin. Runs last, after highlighting, so it sees the final tree.
 *
 * `tail` stamps each span with its distance from the newest word, which only
 * the sweep reads.
 */
export function rehypeStreamWords(options?: { tail?: boolean }) {
  const tail = options?.tail === true
  return (tree: Node) => {
    wrapTail(tree, tail)
  }
}

/** The span attributes for a word `distance` back from the newest one, so a
 *  preview can draw the same thing this pass emits without going through
 *  markdown. Returns nothing past the ramp, exactly as the pass does. */
export function streamWordProps(
  effect: StreamEffect,
  distance: number
): { "data-tail"?: string; style?: React.CSSProperties } {
  if (!needsTail(effect) || distance >= TAIL_WORDS) return {}
  return {
    "data-tail": String(distance),
    style: { ["--tail" as string]: distance } as React.CSSProperties,
  }
}

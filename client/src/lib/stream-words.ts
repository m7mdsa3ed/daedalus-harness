/* ── The streaming reveal ──
   The pacer (`hooks/use-streamed-text`) decides *when* each word of a live turn
   appears; this decides what appearing looks like: the sweep, a soft edge over
   the newest words that travels forward as they arrive. It is the one effect —
   there is no picker — and calm motion is its only off switch
   (`resolveStreamEffect`).

   The softness is a property of *position*, not of arrival, so only the last
   `TAIL_WORDS` words are wrapped, `--tail` (0 = newest) is stamped on them, the
   ramp is CSS's, and a transition on the derived opacity/filter turns a
   discrete shift into a moving edge. Words behind the ramp are at rest and get
   no node at all — a word leaves by having its span unmounted and its text
   folded back into the plain text node in front of it, which is invisible
   because the ramp ends on the resting appearance. A 900-word answer stays a
   text node plus eight spans, and only eight words ever carry a `filter`.

   `pre`/`code` subtrees are skipped: a fence completing rewrites that whole
   subtree, so every token in it would remount and the block would flash as
   one — and rehype-highlight has already split it into spans that mean
   something else. */

/** `none` is the reveal under calm motion: prose painted as it arrives. */
export type StreamEffect = "sweep" | "none"

/** Does this effect wrap the tail? Only the sweep does. */
export function needsTail(effect: StreamEffect | undefined): boolean {
  return effect === "sweep"
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

const wordSpan = (word: string, tail: number): Node => ({
  type: "element",
  tagName: "span",
  properties: {
    className: ["t-stream-w"],
    /* `--tail` is what CSS divides down into a 0…1 position; the attribute is
       what the selector matches, so words past the ramp carry no filter. */
    "data-tail": String(tail),
    style: `--tail:${tail}`,
  },
  children: [{ type: "text", value: word }],
})

/**
 * Wrap the last `TAIL_WORDS` words, walking from the end of the tree backwards.
 *
 * Slots are rewritten back to front, which is also why the recorded indices stay
 * valid: splicing a later slot cannot move an earlier one, even when both sit in
 * the same parent.
 */
function wrapTail(tree: Node): void {
  const slots: Slot[] = []
  collect(tree, slots)

  const budget = TAIL_WORDS
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
        replacement.unshift(wordSpan(token, taken))
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

/** Rehype plugin. Runs last, after highlighting, so it sees the final tree. */
export function rehypeStreamWords() {
  return (tree: Node) => {
    wrapTail(tree)
  }
}

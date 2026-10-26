/* ── Heading ids for a markdown document ──
   A file read in the Preview panel is a document, and documents link to their
   own headings: a table of contents is `[Title](#title)`. Without ids those
   links go nowhere, so this gives every heading the slug GitHub would —
   lowercase, punctuation dropped, spaces to hyphens, `-1`/`-2` for repeats —
   so a TOC written for GitHub resolves here unchanged.

   The id carries GitHub's `user-content-` prefix (the same clobber prefix
   remark-rehype puts on footnotes) so a document's ids cannot collide with the
   app's own; `MarkdownDocument` resolves a bare `#slug` against it. */
import { toText } from "hast-util-to-text"
import { visit } from "unist-util-visit"

export const HEADING_ID_PREFIX = "user-content-"

/** Minimal hast, spelled locally like `lib/highlight`. */
interface Node {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
}

const HEADING = /^h[1-6]$/

export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-")
}

/** Rehype plugin: an `id` on every heading that does not already have one. */
export function rehypeHeadingIds() {
  return (tree: Node) => {
    const seen = new Map<string, number>()
    visit(tree as never, "element", (node: Node) => {
      if (!node.tagName || !HEADING.test(node.tagName)) return
      const properties = (node.properties ??= {})
      if (properties.id) return
      const base = headingSlug(toText(node as never))
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      properties.id = HEADING_ID_PREFIX + (count ? `${base}-${count}` : base)
    })
  }
}

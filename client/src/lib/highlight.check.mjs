/* The one runnable check behind `lib/highlight.ts`, which replaced
   `rehype-highlight` with a narrowed grammar registry. What can break here is
   not the tree walk (it is copied) but the *registry*: an alias that silently
   stops resolving, or a language that quietly leaves the list, is a fence that
   renders grey and nobody notices for a month.

   The tree is built by hand rather than through remark, so this needs nothing
   the app does not already ship.

     node --experimental-strip-types src/lib/highlight.check.mjs   (from client/)
*/
import assert from "node:assert"
import { rehypeHighlight } from "./highlight.ts"

const classesOf = (node) => {
  const out = []
  const walk = (n) => {
    if (n.properties?.className) out.push(...n.properties.className)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out
}

/** The hast react-markdown hands the plugin for one fenced block. */
const fence = (lang, code) => ({
  type: "root",
  children: [
    {
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: lang ? [`language-${lang}`] : [] },
          children: [{ type: "text", value: code }],
        },
      ],
    },
  ],
})

const run = (lang, code) => {
  const tree = fence(lang, code)
  rehypeHighlight()(tree)
  return classesOf(tree)
}

const highlighted = (classes) => classes.some((c) => c.startsWith("hljs-"))

// A registered grammar colours its keywords.
assert(highlighted(run("ts", "const x: number = 1")), "ts fence is highlighted")

// Aliases the grammars declare for themselves.
assert(highlighted(run("py", "def f(): pass")), "py resolves to python")
assert(highlighted(run("yml", "a: 1")), "yml resolves to yaml")

// Aliases registered by hand — the ones that break silently.
assert(highlighted(run("tsx", "const x = 1")), "tsx resolves to typescript")
assert(highlighted(run("html", "<b>hi</b>")), "html resolves to xml")

// A language we did not register: the block still gets its `hljs` ground, the
// text inside it is left alone, and nothing throws.
const unknown = run("brainfuck", "+++.")
assert(unknown.includes("hljs"), "unknown language still gets the hljs class")
assert(!highlighted(unknown), "unknown language is not coloured")

// No language: untouched entirely. `detect` is off by construction — guessing
// paints a shell transcript as Perl.
assert(run(null, "just text").length === 0, "a bare fence is left alone")

// Explicit opt-out.
assert(
  (() => {
    const tree = fence(null, "x")
    tree.children[0].children[0].properties.className = ["no-highlight"]
    rehypeHighlight()(tree)
    return !classesOf(tree).includes("hljs")
  })(),
  "no-highlight is honoured"
)

console.log("highlight.ts: ok")

/* ── Syntax highlighting, narrowed ──
   This replaces `rehype-highlight`, which is twenty lines of tree walk wrapped
   around one line that is the whole cost: `import {common} from 'lowlight'`.
   That import is static, so passing `languages` to it narrowed what *resolved*
   and not what *shipped* — about 180KB gzipped of grammars, in the entry chunk,
   paid by every reader on every cold load whether or not a transcript ever
   holds a fence.

   So the walk is copied (it is short, and it is the part that is correct) and
   the registry is ours: `createLowlight` with the grammars named below and
   nothing else. Adding a language is one import and one row — and the ones
   worth adding are the ones that show up in fences, not the ones highlight.js
   happens to bundle.

   Aliases come free: each grammar declares its own (`sh`, `js`, `ts`, `yml`,
   `py`), and `createLowlight` registers them, so a fence marked ```yml still
   lands on the yaml grammar.

   `detect` is deliberately absent rather than optional. Left to guess,
   highlight.js paints a shell transcript as Perl, which is worse than no
   colour; a fence with no language is left alone, and a fence naming a
   language we did not register is left alone too (silently — the message
   `rehype-highlight` put on the vfile had no reader). */
import { toText } from "hast-util-to-text"
import { createLowlight } from "lowlight"
import { visit } from "unist-util-visit"

import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cpp from "highlight.js/lib/languages/cpp"
import csharp from "highlight.js/lib/languages/csharp"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import go from "highlight.js/lib/languages/go"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import php from "highlight.js/lib/languages/php"
import python from "highlight.js/lib/languages/python"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
})

/* `tsx`/`jsx` are not grammars of their own in highlight.js — the ts and js
   ones already parse them — but they are what a fence is labelled, so they are
   registered as what they are. `html` is xml's, and `sh` is bash's own alias
   only when bash is registered, which it is. */
lowlight.registerAlias({
  javascript: ["jsx", "mjs", "cjs"],
  typescript: ["tsx", "mts", "cts"],
  xml: ["html", "svg", "vue"],
  ini: ["toml"],
  bash: ["zsh", "console"],
})

/** The fence's declared language, or `false` for an explicit opt-out. Mirrors
    rehype-highlight: `language-x` and the older `lang-x`, first one wins. */
function languageOf(list: unknown): false | string | undefined {
  if (!Array.isArray(list)) return undefined
  let name: string | undefined
  for (const entry of list) {
    const value = String(entry)
    if (value === "no-highlight" || value === "nohighlight") return false
    if (!name && value.startsWith("lang-")) name = value.slice(5)
    if (!name && value.startsWith("language-")) name = value.slice(9)
  }
  return name
}

/** Minimal hast, spelled locally for the same reason `lib/stream-words` does:
    four fields, and `@types/hast` would be the larger commitment. */
interface Node {
  type: string
  tagName?: string
  children?: unknown[]
  properties?: Record<string, unknown>
}

/** Rehype plugin. Drop-in for `rehype-highlight` at the one call site that
    used it, minus `detect`, `plainText` and `prefix` — none of which the app
    passed. */
export function rehypeHighlight() {
  return (tree: Node) => {
    visit(tree as never, "element", (node: Node, _index, parent?: Node) => {
      if (node.tagName !== "code" || parent?.tagName !== "pre") return

      const properties = (node.properties ??= {})
      const lang = languageOf(properties.className)
      if (!lang) return

      if (!Array.isArray(properties.className)) properties.className = []
      const classes = properties.className as string[]
      if (!classes.includes("hljs")) classes.unshift("hljs")

      let result
      try {
        result = lowlight.highlight(lang, toText(node as never, { whitespace: "pre" }))
      } catch {
        // Not a grammar we registered. The `hljs` class above still gives the
        // block its background; the text inside it just stays one colour.
        return
      }
      if (result.children.length > 0) node.children = result.children
    })
  }
}

export default rehypeHighlight

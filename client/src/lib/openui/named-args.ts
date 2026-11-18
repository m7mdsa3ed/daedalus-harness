/* ── Named arguments, made positional ──
   The one mistake that makes a whole program draw nothing (see the header of
   `openui-view.tsx`): `Stat(label="a", value="1")` or `Stat(label: "a")`. The
   language is positional, so every prop comes out null. The repair is
   mechanical once the component's prop order is known — the order its zod
   shape declares, which is the order the prompt's signatures print — so each
   named value is moved into its slot, a skipped optional slot becomes `null`
   (which the parser reads as absent), and trailing nulls are trimmed.

   Pure text in, text out: strings are skipped whole, nesting is tracked, and
   only a call to a component `order` knows is touched — `@Each(...)`, a
   `{key: value}` object and a ternary's `a ? b : c` are left as written. */

const NAMED = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=(?!=)|:)\s*/
const IDENT = /[A-Za-z0-9_]/

/** Index past the string literal opening at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start]
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1
  return index + 1
}

/** Index of the `)` closing the `(` at `open`, or -1 when the program is cut short. */
function closeOf(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '"' || char === "'") index = skipString(text, index) - 1
    else if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") {
      depth--
      if (depth === 0) return char === ")" ? index : -1
    }
  }
  return -1
}

/** The top-level arguments of an argument list, untrimmed. */
function splitArgs(inner: string): string[] {
  const args: string[] = []
  let depth = 0
  let from = 0
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]
    if (char === '"' || char === "'") index = skipString(inner, index) - 1
    else if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") depth--
    else if (char === "," && depth === 0) {
      args.push(inner.slice(from, index))
      from = index + 1
    }
  }
  if (inner.slice(from).trim() !== "" || args.length > 0) args.push(inner.slice(from))
  return args
}

function rewrite(text: string, order: (component: string) => readonly string[] | undefined): string {
  let out = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      const end = skipString(text, index)
      out += text.slice(index, end)
      index = end
      continue
    }
    const startsWord = /[A-Za-z_]/.test(char) && (index === 0 || !/[A-Za-z0-9_@.$]/.test(text[index - 1]))
    if (!startsWord) {
      out += char
      index++
      continue
    }
    let end = index
    while (end < text.length && IDENT.test(text[end])) end++
    const name = text.slice(index, end)
    let paren = end
    while (paren < text.length && /\s/.test(text[paren])) paren++
    const keys = text[paren] === "(" ? order(name) : undefined
    const close = keys ? closeOf(text, paren) : -1
    if (!keys || close < 0) {
      out += name
      index = end
      continue
    }
    const args = splitArgs(text.slice(paren + 1, close)).map((arg) => rewrite(arg, order))
    if (!args.some((arg) => NAMED.test(arg))) {
      out += `${text.slice(index, paren)}(${args.join(",")})`
    } else {
      const slots: (string | undefined)[] = []
      args.forEach((arg, position) => {
        const named = NAMED.exec(arg)
        if (!named) return void (slots[position] = arg.trim())
        const slot = keys.indexOf(named[1])
        // ponytail: a name the component does not declare has no slot, so it is dropped.
        if (slot >= 0) slots[slot] = arg.slice(named[0].length).trim()
      })
      while (slots.length > 0 && slots[slots.length - 1] === undefined) slots.pop()
      out += `${name}(${Array.from(slots, (slot) => slot ?? "null").join(", ")})`
    }
    index = close + 1
  }
  return out
}

/**
 * The program with every named argument moved to its positional slot, or null
 * when there was nothing to move — which is what says "no fix to offer".
 */
export function positionalize(
  code: string,
  order: (component: string) => readonly string[] | undefined
): string | null {
  const fixed = rewrite(code, order)
  return fixed === code ? null : fixed
}

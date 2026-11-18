/* Named arguments are moved to the component's positional slots, and the
   repaired program parses to the props the model meant.

     pnpm exec tsx --tsconfig tsconfig.app.json src/lib/openui/named-args.check.mjs   (from client/)
*/
import assert from "node:assert"
import { createParser } from "@openuidev/react-lang"
import { openuiLibrary } from "./library.tsx"
import { positionalize } from "./named-args.ts"

const order = (name) => {
  const def = openuiLibrary.components[name]
  return def ? Object.keys(def.props.shape) : undefined
}
const parser = createParser(openuiLibrary.toJSONSchema())

// Already positional: nothing to fix, byte for byte.
const good = 'root = Stack([s], "row")\ns = Stat("Users", "12")\nt = @Each(rows, "r", Text(r.name))\no = List([{text: "a", meta: "b"}])'
assert.strictEqual(positionalize(good, order), null)

// `=` and `:`, out of order, a skipped optional slot, nested inside an array.
const bad = 'root = Stack([s, c], direction: "row")\ns = Stat(value="12", label="Users", delta="+3")\nc = Callout(text: "Hi, (there)", title: "x = y")'
const fixed = positionalize(bad, order)
assert.strictEqual(
  fixed,
  'root = Stack([s, c], "row")\ns = Stat("Users", "12", null, "+3")\nc = Callout("Hi, (there)", null, "x = y")'
)
const result = parser.parse(fixed)
assert.deepStrictEqual(result.meta.errors, [])
assert.deepStrictEqual(result.root.props.children[0].props, { label: "Users", value: "12", hint: null, delta: "+3" })

// A call nested in a named argument is repaired too.
assert.strictEqual(
  positionalize('root = Stack(children=[Stat(label="a", value="1")])', order),
  'root = Stack([Stat("a", "1")])'
)

// A program cut short is left alone rather than guessed at.
assert.strictEqual(positionalize('root = Stack([Stat(label="a"', order), null)

console.log("named-args: ok")

/* The runnable check behind the Preview panel's tabs and history.

     ../server/node_modules/.bin/tsx src/lib/workspace/preview-nav.check.mjs   (from client/)
*/
import assert from "node:assert"

import {
  EMPTY_HISTORY,
  addTab,
  canGoBack,
  canGoForward,
  closeTab,
  dropFromHistory,
  dropTabs,
  goBack,
  goForward,
  historyPath,
  remap,
  remapHistory,
  tabLabels,
  visit,
  within,
} from "./preview-nav.ts"

// A history walks like a browser's: forward is lost by a new visit.
let h = EMPTY_HISTORY
assert.equal(canGoBack(h), false)
h = visit(visit(visit(h, "a"), "b"), "c")
assert.deepEqual(h.stack, ["a", "b", "c"])
assert.equal(visit(h, "c"), h, "looking where you already are is not a visit")
h = goBack(goBack(h))
assert.equal(historyPath(h), "a")
assert.equal(canGoBack(h), false)
assert.equal(canGoForward(h), true)
assert.equal(historyPath(goForward(h)), "b")
h = visit(goForward(h), "d")
assert.deepEqual(h.stack, ["a", "b", "d"], "a new place drops what was ahead")
assert.equal(canGoForward(h), false)
assert.equal(goBack(EMPTY_HISTORY), EMPTY_HISTORY)

// The cap keeps the newest.
let long = EMPTY_HISTORY
for (let i = 0; i < 80; i++) long = visit(long, `f${i}`)
assert.equal(long.stack.length, 50)
assert.equal(historyPath(long), "f79")

// Paths: a folder is not a prefix of its lookalike.
assert.ok(within("src/a.ts", "src"))
assert.ok(within("src", "src"))
assert.ok(!within("src2/a.ts", "src"))
assert.equal(remap("src/a/b.ts", "src/a", "lib/a"), "lib/a/b.ts")
assert.equal(remap("src2/a.ts", "src", "lib"), "src2/a.ts")
assert.deepEqual(remapHistory({ stack: ["src/a.ts", "x"], index: 1 }, "src", "lib").stack, ["lib/a.ts", "x"])

// Deleting drops places and keeps the reader on what is nearest.
let d = dropFromHistory({ stack: ["a", "dir/b", "dir/c", "d"], index: 2 }, (p) => within(p, "dir"))
assert.deepEqual(d.stack, ["a", "d"])
assert.equal(historyPath(d), "a", "the nearest earlier place")
d = dropFromHistory({ stack: ["dir/a"], index: 0 }, (p) => within(p, "dir"))
assert.deepEqual(d, EMPTY_HISTORY)
d = dropFromHistory({ stack: ["a", "dir/b", "a"], index: 2 }, (p) => within(p, "dir"))
assert.deepEqual(d.stack, ["a"], "neighbours made adjacent are one stop")
assert.equal(d.index, 0)

// Tabs: closing the front tab hands over to the right neighbour, else the left.
assert.deepEqual(addTab(["a"], "a"), ["a"])
assert.deepEqual(addTab(["a"], "b"), ["a", "b"])
assert.deepEqual(closeTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], file: "c" })
assert.deepEqual(closeTab(["a", "b", "c"], "c", "c"), { tabs: ["a", "b"], file: "b" })
assert.deepEqual(closeTab(["a", "b"], "a", "b"), { tabs: ["a"], file: "a" })
assert.deepEqual(closeTab(["a"], "a", "a"), { tabs: [], file: undefined })
assert.deepEqual(closeTab(["a"], "a", "zzz"), { tabs: ["a"], file: "a" })

// A deleted folder closes its files, and the front tab lands on what survives.
assert.deepEqual(dropTabs(["a", "dir/b", "dir/c", "z"], "dir/b", (p) => within(p, "dir")), { tabs: ["a", "z"], file: "z" })
assert.deepEqual(dropTabs(["dir/b"], "dir/b", (p) => within(p, "dir")), { tabs: [], file: undefined })
assert.deepEqual(dropTabs(["a"], "dir/x", (p) => within(p, "dir")), { tabs: ["a"], file: undefined }, "a file in front that was never a tab")

// Same-named tabs tell themselves apart by their folder.
assert.deepEqual(tabLabels(["src/index.ts", "lib/index.ts", "README.md"]), [
  { path: "src/index.ts", name: "index.ts", hint: "src" },
  { path: "lib/index.ts", name: "index.ts", hint: "lib" },
  { path: "README.md", name: "README.md" },
])

console.log("preview-nav.check.mjs passed")

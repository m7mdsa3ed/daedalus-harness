/* The runnable check behind the Preview panel's unsaved edits.

     ../server/node_modules/.bin/tsx src/lib/workspace/edit-drafts.check.mjs   (from client/)
*/
import assert from "node:assert"

import { clearDraft, dirtyPaths, dropDrafts, getDraft, isDirty, moveDrafts, setDraft } from "./edit-drafts.ts"

const clean = (text, version = "v1") => ({ text, base: text, version })
const edited = (base, text, version = "v1") => ({ text, base, version })

// An untouched draft is held and is not dirty.
setDraft("p", "a.ts", clean("one"))
assert.equal(isDirty(getDraft("p", "a.ts")), false)
assert.deepEqual(dirtyPaths("p"), [])

// Typing makes it dirty; saving (base catches up) makes it clean again.
setDraft("p", "a.ts", edited("one", "one!"))
assert.deepEqual(dirtyPaths("p"), ["a.ts"])
setDraft("p", "a.ts", { text: "one!", base: "one!", version: "v2" })
assert.deepEqual(dirtyPaths("p"), [])

// Projects do not see each other's drafts, and a path is not a prefix match.
setDraft("p", "src/a.ts", edited("a", "b"))
setDraft("q", "src/a.ts", edited("a", "c"))
setDraft("p", "src2/a.ts", edited("a", "d"))
assert.deepEqual(dirtyPaths("p"), ["src/a.ts", "src2/a.ts"])
assert.deepEqual(dirtyPaths("q"), ["src/a.ts"])

// A rename takes the drafts under it along, and only those.
moveDrafts("p", "src", "lib")
assert.deepEqual(dirtyPaths("p"), ["lib/a.ts", "src2/a.ts"])
assert.equal(getDraft("p", "src/a.ts"), undefined)
assert.equal(getDraft("p", "lib/a.ts").text, "b")
assert.deepEqual(dirtyPaths("q"), ["src/a.ts"])

// A delete drops a folder's drafts and leaves the lookalike.
dropDrafts("p", "lib")
assert.deepEqual(dirtyPaths("p"), ["src2/a.ts"])
clearDraft("p", "src2/a.ts")
assert.deepEqual(dirtyPaths("p"), [])

console.log("edit-drafts.check.mjs passed")

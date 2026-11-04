/* The walk behind `cycleSetup`: fixed order, wraps, and pulls in a current
   setup the list has never seen.

     node --experimental-strip-types src/lib/config-recents.check.mjs   (from client/)
*/
import assert from "node:assert"
import { nextRecentSetup } from "./config-recents.ts"

const c = (model) => ({ agentId: "a", profileId: "p", model, effort: "" })
const list = (...models) => models.map((m) => ({ config: c(m) }))

// A → B → C → A, not a flip between the newest two.
assert.equal(nextRecentSetup(list("a", "b", "c"), c("a")).model, "b")
assert.equal(nextRecentSetup(list("a", "b", "c"), c("b")).model, "c")
assert.equal(nextRecentSetup(list("a", "b", "c"), c("c")).model, "a")
// Only the current setup and the three the menu shows are walked.
assert.equal(nextRecentSetup(list("a", "b", "c", "d", "e"), c("d")).model, "a")
// An unseen current setup joins the walk at its head.
assert.equal(nextRecentSetup(list("a", "b"), c("x")).model, "a")
// Nothing else to go to.
assert.equal(nextRecentSetup(list("a"), c("a")), null)
assert.equal(nextRecentSetup([], c("x")), null)

console.log("config-recents.check: ok")

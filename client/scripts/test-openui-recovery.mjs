import assert from "node:assert/strict"
import { recoverUnfencedOpenui } from "../src/lib/openui/recover-unfenced.ts"

const malformed = `root Stack([summary, stats])
summary = Section("Usage", "Current totals")
stats = StatRow([
  Stat("Calls", "12"),
  Stat("Errors", "0")
])`
const repaired = `root = Stack([summary, stats])
summary = Section("Usage", "Current totals")
stats = StatRow([
  Stat("Calls", "12"),
  Stat("Errors", "0")
])`

assert.deepEqual(
  recoverUnfencedOpenui(malformed),
  { code: repaired, remainder: "" },
  "repairs a missing root equals sign and keeps multiline expressions",
)
assert.deepEqual(
  recoverUnfencedOpenui(`${repaired}\n\nA short explanation.`),
  { code: repaired, remainder: "A short explanation." },
  "preserves prose after a complete OpenUI program",
)
assert.deepEqual(
  recoverUnfencedOpenui(`${repaired}\n\n${"```"}suggest-prompts\nNext\n${"```"}`),
  { code: repaired, remainder: `${"```"}suggest-prompts\nNext\n${"```"}` },
  "preserves a following fenced block as markdown remainder",
)
assert.deepEqual(
  recoverUnfencedOpenui(`root: Stack([body])\nbody Section("Recovered")`),
  { code: `root = Stack([body])\nbody = Section("Recovered")`, remainder: "" },
  "repairs a colon root and a missing variable assignment operator",
)
assert.deepEqual(
  recoverUnfencedOpenui(`root = Stack([summary, stats])\nsummary = Section("Usage")\nstats = List(["one", "two"`),
  {
    code: `root = Stack([summary, stats])\nsummary = Section("Usage")\nstats = List(["one", "two"])`,
    remainder: "",
  },
  "closes unmatched delimiters only at the end of the program",
)
assert.equal(recoverUnfencedOpenui("root Stack([body])"), null)
assert.equal(recoverUnfencedOpenui("A normal answer.\nbody = Section(\"text\")"), null)
assert.equal(recoverUnfencedOpenui("root = Stack([body])\nThis line is ambiguous"), null)
assert.deepEqual(
  recoverUnfencedOpenui(`root = Stack([body])\nbody = Section("Recovered"\n\nHere is the explanation.`),
  { code: `root = Stack([body])\nbody = Section("Recovered")`, remainder: "Here is the explanation." },
  "keeps prose after an incomplete program outside the recovered view",
)
assert.equal(recoverUnfencedOpenui(`root = Stack([body])\nbody = Section("unterminated)`), null)
assert.equal(recoverUnfencedOpenui(`root = Stack([body])\nbody = Section("mismatch"]`), null)

console.log("openui recovery tests passed")

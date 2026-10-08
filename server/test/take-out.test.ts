// Self-check for git.takeOut: a thread's own edits come back out of a file a
// peer also wrote, newest first, and an edit that cannot be placed refuses.
import assert from "node:assert/strict";
import { takeOut } from "../src/git.js";

assert.equal(
  takeOut("a\nB2\nc\nPEER\n", [{ oldText: "b", newText: "B1" }, { oldText: "B1", newText: "B2" }]),
  "a\nb\nc\nPEER\n",
);
assert.equal(takeOut("x\n", [{ oldText: "a", newText: "gone" }]), null);
assert.equal(takeOut("dup dup", [{ oldText: "a", newText: "dup" }]), null);
console.log("take-out ok");

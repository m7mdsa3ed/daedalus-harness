// Self-check for `parseNumstat` (src/git.ts): the `git diff --numstat -z`
// reader behind the working set's and a commit's line counts. A rename is the
// one record spread over three NUL fields; a binary file (`-\t-`) has no count.
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { parseNumstat } from "../src/git.js";

const stats = parseNumstat("3\t1\tsrc/a.ts\0" + "1\t0\t\0old.txt\0new.txt\0" + "-\t-\tlogo.png\0" + "0\t4\tb c.md\0");
assert.deepEqual(stats.get("src/a.ts"), { insertions: 3, deletions: 1 });
assert.deepEqual(stats.get("new.txt"), { insertions: 1, deletions: 0, from: "old.txt" });
assert.equal(stats.has("old.txt"), false);
assert.equal(stats.has("logo.png"), false);
assert.deepEqual(stats.get("b c.md"), { insertions: 0, deletions: 4 });
assert.equal(parseNumstat("").size, 0);
console.log("git-numstat: ok");

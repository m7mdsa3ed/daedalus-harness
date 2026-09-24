/* The one runnable check behind `lib/workspace/hunks.ts`: every hunk it cuts
   must be one `git apply --cached` takes, and staging it must stage exactly
   that hunk — the index afterwards is the original with this change and no
   other. Revert is checked the same way against the file text. Needs git.

     node --experimental-strip-types src/lib/workspace/hunks.check.mjs   (from client/)
*/
import assert from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hunkPatch, revertHunk } from "./hunks.ts"

const git = (dir, args, input) =>
  execFileSync("git", args, { cwd: dir, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })

/* Hand-written line changes, as Monaco reports them (1-based, 0 = none). */
const cases = [
  {
    name: "modify middle",
    original: "a\nb\nc\nd\ne\nf\ng\nh\n",
    modified: "a\nb\nc\nD\ne\nf\ng\nH\n",
    changes: [
      { originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
      { originalStartLineNumber: 8, originalEndLineNumber: 8, modifiedStartLineNumber: 8, modifiedEndLineNumber: 8 },
    ],
  },
  {
    name: "insert and delete",
    original: "one\ntwo\nthree\nfour\n",
    modified: "zero\none\ntwo\nfour\n",
    changes: [
      { originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 },
      { originalStartLineNumber: 3, originalEndLineNumber: 3, modifiedStartLineNumber: 3, modifiedEndLineNumber: 0 },
    ],
  },
  {
    name: "no newline at end",
    original: "x\ny",
    modified: "x\nY",
    changes: [
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    ],
  },
]

for (const { name, original, modified, changes } of cases) {
  changes.forEach((change, i) => {
    const dir = mkdtempSync(join(tmpdir(), "hunks-"))
    git(dir, ["init", "-q"])
    writeFileSync(join(dir, "f.txt"), original)
    git(dir, ["add", "f.txt"])
    writeFileSync(join(dir, "f.txt"), modified)
    git(dir, ["apply", "--cached", "-"], hunkPatch("f.txt", original, modified, change))
    const staged = git(dir, ["show", ":f.txt"])
    /* Staging hunk i leaves the worktree ↔ index diff as every *other* hunk;
       reverting every other hunk from the worktree must give the same text. */
    let expected = modified
    for (const other of [...changes.keys()].filter((j) => j !== i).reverse())
      expected = revertHunk(original, expected, changes[other])
    assert.strictEqual(staged, expected, `${name}: staging hunk ${i}`)
    /* Reverting every hunk, last first, gives the original back. */
    if (i === 0) {
      let all = modified
      for (const each of [...changes].reverse()) all = revertHunk(original, all, each)
      assert.strictEqual(all, original, `${name}: revert all`)
    }
  })
}
console.log("hunks: ok")

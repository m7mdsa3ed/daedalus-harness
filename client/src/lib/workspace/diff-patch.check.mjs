/* The one runnable check behind `diff-patch.ts`: picking some lines of a hunk
   must stage (or unstage) exactly those lines in a real index.

     node --experimental-strip-types src/lib/workspace/diff-patch.check.mjs   (from client/)
*/
import assert from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePatch, patchFor } from "./diff-patch.ts"

const dir = mkdtempSync(join(tmpdir(), "diff-patch-"))
const git = (args, input) => execFileSync("git", args, { cwd: dir, input, encoding: "utf8" })
git(["init", "-q"])
git(["config", "user.email", "a@b.c"])
git(["config", "user.name", "t"])
writeFileSync(join(dir, "f.txt"), "a\nb\nc\nd\ne\n")
git(["add", "."])
git(["commit", "-qm", "init"])
writeFileSync(join(dir, "f.txt"), "a\nB\nc\nd\nx\ne\n")

const file = parsePatch(git(["diff"]))
assert.equal(file.hunks.length, 1)
const hunk = file.hunks[0]
const at = (kind, text) => hunk.lines.findIndex((l) => l.kind === kind && l.text === text)

// Stage only the added "x": the index gets it, "b" stays as it was.
git(["apply", "--cached", "-"], patchFor(file, hunk, new Set([at("+", "x")])))
assert.equal(git(["show", ":f.txt"]), "a\nb\nc\nd\nx\ne\n")

// Unstage it again with the reverse patch.
const staged = parsePatch(git(["diff", "--cached"]))
const sx = staged.hunks[0].lines.findIndex((l) => l.kind === "+" && l.text === "x")
git(["apply", "--cached", "--reverse", "-"], patchFor(staged, staged.hunks[0], new Set([sx]), true))
assert.equal(git(["show", ":f.txt"]), "a\nb\nc\nd\ne\n")

// Whole hunk, then nothing picked is nothing to apply.
git(["apply", "--cached", "-"], patchFor(file, hunk))
assert.equal(git(["show", ":f.txt"]), "a\nB\nc\nd\nx\ne\n")
assert.equal(patchFor(file, hunk, new Set()), null)
console.log("diff-patch ok")

// Whole change staged, then unstage only "x" (reverse, partial): "B" stays staged.
const both = parsePatch(git(["diff", "--cached"]))
const bx = both.hunks[0].lines.findIndex((l) => l.kind === "+" && l.text === "x")
git(["apply", "--cached", "--reverse", "-"], patchFor(both, both.hunks[0], new Set([bx]), true))
assert.equal(git(["show", ":f.txt"]), "a\nB\nc\nd\ne\n")
console.log("partial reverse ok")

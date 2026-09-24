// Self-check for reverting one turn (git.revertTurn) and the branch base
// (git.branchBase): a turn's modified/created/deleted paths go back to its
// start tree in the working tree only — the real index and every other path
// untouched — refused with the paths when one moved since the turn ended,
// and done anyway under force.
// Run: pnpm test:turn-revert
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = await import("../src/git.js");

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo = mkdtempSync(join(tmpdir(), "daedalus-revert-"));
sh(repo, "init", "-q", "-b", "main");
sh(repo, "config", "user.email", "t@example.com");
sh(repo, "config", "user.name", "t");
writeFileSync(join(repo, "keep.txt"), "keep\n");
writeFileSync(join(repo, "edit.txt"), "before\n");
writeFileSync(join(repo, "gone.txt"), "was here\n");
sh(repo, "add", ".");
sh(repo, "commit", "-q", "-m", "init");

// The branch base: HEAD on main is the base itself.
assert.ok("unavailable" in (await git.branchBase(repo)));

// A staged change the user made before the turn: the index must survive.
writeFileSync(join(repo, "keep.txt"), "keep, staged\n");
sh(repo, "add", "keep.txt");
const indexBefore = sh(repo, "ls-files", "-s");

const start = await git.snapshotTree(repo);
writeFileSync(join(repo, "edit.txt"), "after\n");
writeFileSync(join(repo, "new.txt"), "created\n");
unlinkSync(join(repo, "gone.txt"));
const end = await git.snapshotTree(repo);

// A later edit to one of the turn's paths: refused, nothing written.
writeFileSync(join(repo, "edit.txt"), "after, then edited again\n");
const refused = await git.revertTurn(repo, start, end, false);
assert.deepEqual(refused.reverted, []);
assert.deepEqual(refused.conflicts, ["edit.txt"]);
assert.ok(existsSync(join(repo, "new.txt")), "a refusal writes nothing");

// Forced: every path of the turn goes back, nothing else moves.
const forced = await git.revertTurn(repo, start, end, true);
assert.deepEqual([...forced.reverted].sort(), ["edit.txt", "gone.txt", "new.txt"]);
assert.equal(readFileSync(join(repo, "edit.txt"), "utf8"), "before\n", "modified → restored");
assert.ok(!existsSync(join(repo, "new.txt")), "created → deleted");
assert.equal(readFileSync(join(repo, "gone.txt"), "utf8"), "was here\n", "deleted → recreated");
assert.equal(readFileSync(join(repo, "keep.txt"), "utf8"), "keep, staged\n", "other paths untouched");
assert.equal(sh(repo, "ls-files", "-s"), indexBefore, "the real index is never touched");

// Unforced on a clean turn: reverted outright.
const start2 = await git.snapshotTree(repo);
writeFileSync(join(repo, "edit.txt"), "second turn\n");
const end2 = await git.snapshotTree(repo);
const clean = await git.revertTurn(repo, start2, end2, false);
assert.deepEqual(clean, { reverted: ["edit.txt"], conflicts: [] });
assert.equal(readFileSync(join(repo, "edit.txt"), "utf8"), "before\n");

// A branch of its own has a base: the merge-base with main.
sh(repo, "commit", "-q", "-am", "wip");
const mainTip = sh(repo, "rev-parse", "HEAD").trim();
sh(repo, "checkout", "-q", "-b", "feature");
writeFileSync(join(repo, "feature.txt"), "f\n");
sh(repo, "add", ".");
sh(repo, "commit", "-q", "-m", "feature");
assert.deepEqual(await git.branchBase(repo), { base: mainTip });

console.log("turn-revert: ok");
process.exit(0);

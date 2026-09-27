// Self-check for a thread's git worktree (git.ts): made inside the project
// under `.daedalus/worktrees/`, on its own branch, ignored through
// `.git/info/exclude` (never the user's .gitignore) so the project's own status
// stays clean; refused for a directory that is not the repository root; and
// removed only when clean unless forced, keeping the branch.
// Run: pnpm test:worktree
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = await import("../src/git.js");
const { WorkspaceError } = await import("../src/workspace-fs.js");

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo = mkdtempSync(join(tmpdir(), "daedalus-wt-"));
sh(repo, "init", "-q", "-b", "main");
sh(repo, "config", "user.email", "t@example.com");
sh(repo, "config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "one\n");
mkdirSync(join(repo, "sub"));
writeFileSync(join(repo, "sub", "b.txt"), "two\n");
sh(repo, "add", ".");
sh(repo, "commit", "-q", "-m", "init");

async function refusal(fn: () => Promise<unknown>): Promise<InstanceType<typeof WorkspaceError>> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof WorkspaceError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const id = "0123abcd-0000-4000-8000-000000000000";
const rel = await git.createWorktree(repo, id);
assert.equal(rel, ".daedalus/worktrees/0123abcd000040008000000000000000");
assert.ok(existsSync(join(repo, rel, "a.txt")), "the worktree is a checkout");
assert.equal(sh(join(repo, rel), "branch", "--show-current").trim(), "daedalus/0123abcd000040008000000000000000");
assert.ok(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").includes(".daedalus/"));
assert.ok(!existsSync(join(repo, ".gitignore")), "the user's .gitignore is never written");
assert.equal(sh(repo, "status", "--porcelain", "--untracked-files=all"), "", "the project's status does not see it");

// A second one does not append the exclude line twice.
const rel2 = await git.createWorktree(repo, "99999999-0000-4000-8000-000000000000");
assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".daedalus/").length, 1);

// Not the repository root: refused.
assert.equal((await refusal(() => git.createWorktree(join(repo, "sub"), "11111111-0000-4000-8000-000000000000"))).status, 400);
// Not a repository at all: refused.
assert.equal((await refusal(() => git.createWorktree(mkdtempSync(join(tmpdir(), "daedalus-nogit-")), id))).status, 400);

// Dirty: refused with what would be lost, then forced.
writeFileSync(join(repo, rel, "new.txt"), "work\n");
const dirty = await refusal(() => git.removeWorktree(repo, rel, false));
assert.equal(dirty.status, 409);
assert.match(dirty.message, /new\.txt/);
assert.ok(existsSync(join(repo, rel)), "a refused remove removes nothing");
await git.removeWorktree(repo, rel, true);
assert.ok(!existsSync(join(repo, rel)));
assert.match(sh(repo, "branch", "--list", "daedalus/0123abcd000040008000000000000000"), /daedalus\/0123abcd000040008000000000000000/, "the branch is kept");

// Clean: removed without force; removing again is a no-op.
await git.removeWorktree(repo, rel2, false);
assert.ok(!existsSync(join(repo, rel2)));
await git.removeWorktree(repo, rel2, false);

console.log("worktree: ok");
process.exit(0);

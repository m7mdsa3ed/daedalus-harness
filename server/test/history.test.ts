// Self-check for the git log's parse (shortstat included) and `restoreToTree`
// — a restore taken from a bare tree object, which is a thread rewind's file
// half: a new commit carrying the old tree, checkpointing uncommitted work
// first, removing files the target did not have, and a no-op onto HEAD's own
// tree. Against a real repository under DATA_DIR.
// Run: pnpm test:history
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../src/config.js";
import { createProject, deleteProject } from "../src/projects.js";
import { log, restoreToTree } from "../src/git.js";
import { WorkspaceError } from "../src/workspace-fs.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
}

const root = join(DATA_DIR, "history-fixture");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd: root, stdio: "pipe" })
    .toString()
    .trim();
git("init", "-q");
writeFileSync(join(root, "a.txt"), "one\n");
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", scripts: { check: "tsc --noEmit" } }));
git("add", "-A");
git("commit", "-q", "-m", "Scaffold");
writeFileSync(join(root, "a.txt"), "one\ntwo\n");
writeFileSync(join(root, "b.txt"), "b\n");
git("add", "-A");
git("commit", "-q", "-m", "Add b and a line");

const project = createProject({ name: "history", cwd: root, description: null, logoUrl: "" });

await test("log lists newest first with shortstat", async () => {
  const commits = await log(project.id);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.subject, "Add b and a line");
  assert.equal(commits[0]!.filesChanged, 2);
  assert.equal(commits[0]!.insertions, 2);
  assert.equal(commits[1]!.subject, "Scaffold");
  assert.match(commits[0]!.hash, /^[0-9a-f]{40}$/);
  assert.equal(commits[0]!.short.length >= 7, true);
  assert.equal(typeof commits[0]!.at, "number");
});

await test("log honours the limit", async () => {
  const commits = await log(project.id, { limit: 1 });
  assert.equal(commits.length, 1);
});

await test("restoreToTree restores a bare tree as a new commit", async () => {
  const commits = await log(project.id);
  const scaffold = commits.find((c) => c.subject === "Scaffold")!;
  const scaffoldTree = git("rev-parse", `${scaffold.hash}^{tree}`);
  const result = await restoreToTree(project.id, scaffoldTree);
  assert.equal(result.restored, true);
  assert.match(result.commit!.subject, /^Rewind:/);
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(git("show", "HEAD:a.txt"), "one");
  assert.equal(git("status", "--porcelain"), "");
});

await test("restoreToTree onto the current tree is a no-op", async () => {
  const headTree = git("rev-parse", "HEAD^{tree}");
  const result = await restoreToTree(project.id, headTree);
  assert.equal(result.restored, false);
  assert.equal(result.commit, null);
});

await test("restoreToTree checkpoints uncommitted work first", async () => {
  writeFileSync(join(root, "e.txt"), "e\n");
  const commits = await log(project.id);
  const scaffold = commits.find((c) => c.subject === "Scaffold")!;
  const scaffoldTree = git("rev-parse", `${scaffold.hash}^{tree}`);
  await restoreToTree(project.id, scaffoldTree);
  const after = await log(project.id);
  assert.equal(after[1]!.subject, "Checkpoint before restore");
  // e.txt is not lost — it is in the checkpoint commit.
  assert.equal(git("show", `${after[1]!.hash}:e.txt`), "e");
  assert.equal(existsSync(join(root, "e.txt")), false);
});

await test("restoreToTree refuses a non-hash and an unknown tree", async () => {
  await assert.rejects(restoreToTree(project.id, "--force"), (e) => e instanceof WorkspaceError && e.status === 400);
  await assert.rejects(restoreToTree(project.id, "deadbeef"), (e) => e instanceof WorkspaceError && e.status === 404);
});

await test("log on a repository with no commits is empty", async () => {
  const bare = join(DATA_DIR, "history-empty");
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: bare });
  const p = createProject({ name: "empty", cwd: bare, description: null, logoUrl: "" });
  try {
    assert.deepEqual(await log(p.id), []);
  } finally {
    deleteProject(p.id);
    rmSync(bare, { recursive: true, force: true });
  }
});

deleteProject(project.id);
rmSync(root, { recursive: true, force: true });

console.log(`history: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);

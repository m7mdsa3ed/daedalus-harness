// Self-check for `commitPlan` and the plan gathering (src/git.ts), against a
// real temporary repository: a plan lands as one commit per entry holding only
// its own files (an edit, a deletion, a rename and a new file), a file the plan
// does not name stays changed, and a plan naming an unknown or doubled path is
// refused before anything is written.
// Run: pnpm test:git-commit-plan
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { db, schema } = await import("../src/db/index.js");
const git = await import("../src/git.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const root = mkdtempSync(join(tmpdir(), "commit-plan-"));
sh(root, "init", "-q", "-b", "main");
sh(root, "config", "user.name", "T");
sh(root, "config", "user.email", "t@example.com");
sh(root, "config", "commit.gpgsign", "false");
for (const name of ["a.txt", "b.txt", "gone.txt", "old.txt", "keep.txt"]) writeFileSync(join(root, name), `${name}\n`);
sh(root, "add", "-A");
sh(root, "commit", "-q", "-m", "init");

writeFileSync(join(root, "a.txt"), "a changed\n");
writeFileSync(join(root, "b.txt"), "b changed\n");
writeFileSync(join(root, "keep.txt"), "left alone\n");
writeFileSync(join(root, "new.txt"), "brand new\n");
unlinkSync(join(root, "gone.txt"));
sh(root, "mv", "old.txt", "renamed.txt");
sh(root, "add", "b.txt");

await db.insert(schema.projects).values({ id: "proj-p", name: "P", cwd: root });

console.log("git-commit-plan");

await test("the plan prompt lists every changed file bare", async () => {
  const { files, prompt } = await git.commitMessagePrompt("proj-p", undefined, "plan");
  assert.deepEqual([...files].sort(), ["a.txt", "b.txt", "gone.txt", "keep.txt", "new.txt", "renamed.txt"]);
  assert.match(prompt, /logical commits/);
  assert.match(prompt, /\+brand new/);
  assert.match(prompt, /\+a changed/);
});

await test("an unknown or doubled path refuses the whole plan", async () => {
  const head = sh(root, "rev-parse", "HEAD");
  await assert.rejects(git.commitPlan("proj-p", [{ message: "x", paths: ["nope.txt"] }]), /no changes/);
  await assert.rejects(
    git.commitPlan("proj-p", [{ message: "x", paths: ["a.txt"] }, { message: "y", paths: ["a.txt"] }]),
    /more than one commit/,
  );
  assert.equal(sh(root, "rev-parse", "HEAD"), head);
});

await test("each commit holds only its own files, and the rest stay changed", async () => {
  await git.commitPlan("proj-p", [
    { message: "feat: a and new", paths: ["a.txt", "new.txt"] },
    { message: "chore: b, rename, delete", paths: ["b.txt", "renamed.txt", "gone.txt"] },
  ]);
  assert.equal(sh(root, "log", "--format=%s", "-3"), "chore: b, rename, delete\nfeat: a and new\ninit");
  assert.equal(sh(root, "show", "--name-only", "--format=", "HEAD~1").split("\n").sort().join(","), "a.txt,new.txt");
  assert.equal(sh(root, "show", "--name-status", "-M", "--format=", "HEAD").split("\n").sort().join(","), "D\tgone.txt,M\tb.txt,R100\told.txt\trenamed.txt");
  assert.equal(sh(root, "status", "--porcelain"), "M keep.txt");
});

rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.log(`git-commit-plan: ${failures.length} failed`);
  process.exit(1);
}
console.log(`git-commit-plan: ${passed} ok`);
process.exit(0);

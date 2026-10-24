// Self-check for the git mention kinds (src/mentions/resolvers/git.ts and
// git-search.ts), against real temporary repositories: a commit's message and
// patch, a branch's commits over the default branch, a tag, the working tree
// (`changes`, `staged`, `stash/N`), a ref that does not exist answering nothing
// while still being claimed, a value shaped like a git option never reaching
// git, a nested repository being found with its name, and the search lists.
// Run: pnpm test:mention-git
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { db, schema } = await import("../src/db/index.js");
const { expandMentions } = await import("../src/mentions/index.js");
const { searchGit } = await import("../src/mentions/git-search.js");

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const root = mkdtempSync(join(tmpdir(), "mention-git-"));
git(root, "init", "-q", "-b", "main");
writeFileSync(join(root, "a.txt"), "one\n");
git(root, "add", "-A");
git(root, "commit", "-q", "-m", "first commit");
writeFileSync(join(root, "a.txt"), "one\ntwo\n");
git(root, "commit", "-q", "-am", "add the second line");
const second = git(root, "rev-parse", "--short", "HEAD");
git(root, "tag", "-a", "v1", "-m", "release one");
git(root, "checkout", "-q", "-b", "feature/x");
writeFileSync(join(root, "b.txt"), "feature work\n");
git(root, "add", "-A");
git(root, "commit", "-q", "-m", "feature commit");
git(root, "checkout", "-q", "main");

// A nested checkout the project holds beside its own.
const nested = join(root, "libs", "inner");
mkdirSync(nested, { recursive: true });
git(nested, "init", "-q", "-b", "main");
writeFileSync(join(nested, "z.txt"), "z\n");
git(nested, "add", "-A");
git(nested, "commit", "-q", "-m", "inner commit");
const inner = git(nested, "rev-parse", "--short", "HEAD");

await db.insert(schema.projects).values({ id: "proj-g", name: "G", cwd: root });
const scope = { projectId: "proj-g", cwd: root };
const expand = (text: string, extra: object = {}) => expandMentions(text, { ...scope, ...extra });

console.log("mention-git");

await test("a commit answers its message, stat and patch", async () => {
  const out = await expand(`see @commit:${second}`);
  assert.match(out.text, /<mention kind="commit" ref="[0-9a-f]+">/);
  assert.match(out.text, /add the second line/);
  assert.match(out.text, /\+two/);
  assert.ok(out.claimed.has(`commit:${second}`));
});

await test("a branch lists its commits over the default branch", async () => {
  const out = await expand("@branch:feature/x");
  assert.match(out.text, /feature commit/);
  assert.match(out.text, /\+feature work/);
  assert.doesNotMatch(out.text, /first commit/);
});

await test("an annotated tag carries its message and commit", async () => {
  const out = await expand("@tag:v1");
  assert.match(out.text, /release one/);
  assert.match(out.text, /add the second line/);
});

await test("a ref nothing has answers nothing and is still claimed", async () => {
  const out = await expand("@commit:deadbeef @branch:nope @tag:nope");
  assert.equal(out.text, "");
  assert.ok(out.claimed.has("commit:deadbeef") && out.claimed.has("branch:nope") && out.claimed.has("tag:nope"));
});

await test("a value shaped like a git option never reaches git", async () => {
  const out = await expand("@branch:--output=/tmp/pwned @tag:-f @branch:a..b @branch:a~1");
  assert.equal(out.text, "");
});

await test("changes, staged and stash read the working tree", async () => {
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "new.txt"), "n\n");
  let out = await expand("@git:changes");
  assert.match(out.text, /\+three/);
  assert.match(out.text, /\?\? new\.txt/);
  out = await expand("@git:staged");
  assert.match(out.text, /Nothing is staged\./, "an empty index is said, not omitted");
});

await test("staged shows the index", async () => {
  git(root, "add", "a.txt");
  const out = await expand("@git:staged");
  assert.match(out.text, /\+three/);
  git(root, "reset", "-q");
});

await test("stash/0 shows the newest stash", async () => {
  git(root, "stash", "push", "-q", "-m", "park it");
  const out = await expand("@git:stash/0");
  assert.match(out.text, /park it/);
  assert.match(out.text, /\+three/);
  git(root, "stash", "drop", "-q");
});

await test("a nested repository is found and named", async () => {
  const out = await expand(`@commit:${inner}`);
  assert.match(out.text, /inner commit/);
  assert.match(out.text, /repository: inner/);
});

await test("last-turn with no thread answers nothing", async () => {
  const out = await expand("@git:last-turn");
  assert.equal(out.text, "");
  assert.ok(out.claimed.has("git:last-turn"));
});

await test("one huge diff is cut to its share and says where the rest is", async () => {
  writeFileSync(join(root, "big.txt"), `${"line of text\n".repeat(5000)}`);
  git(root, "add", "big.txt");
  git(root, "commit", "-q", "-m", "big");
  const big = git(root, "rev-parse", "--short", "HEAD");
  const out = await expandMentions(`@commit:${big}`, { ...scope, budget: 3000 });
  assert.match(out.text, /truncated — read more via `git show <sha>`/);
  assert.ok(out.text.length < 4500);
});

await test("search lists commits, branches, tags and the working-tree options", async () => {
  assert.ok((await searchGit("proj-g", root, "commit", "second")).some((m) => m.label === "add the second line"));
  assert.ok((await searchGit("proj-g", root, "commit", second.slice(0, 5))).some((m) => m.ref === second));
  const branches = await searchGit("proj-g", root, "branch", "");
  assert.equal(branches[0]?.ref, "main", "the checked-out branch leads");
  assert.ok(branches.some((m) => m.ref === "feature/x"));
  assert.ok((await searchGit("proj-g", root, "tag", "v")).some((m) => m.ref === "v1"));
  const working = await searchGit("proj-g", root, "git", "");
  assert.deepEqual(working.slice(0, 3).map((m) => m.ref), ["changes", "staged", "last-turn"]);
  assert.deepEqual((await searchGit("proj-g", root, "git", "stag")).map((m) => m.ref), ["staged"]);
});

rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.log(`mention-git: ${failures.length} failed`);
  process.exit(1);
}
console.log(`mention-git: ${passed} ok`);
process.exit(0);

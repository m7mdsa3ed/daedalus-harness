// Self-check for the project-scoped filesystem: containment (lexical and via
// symlinks), the bounds on listings and reads, binary/oversize detection,
// atomic writes and stale-write conflicts, and the watcher's batching and
// teardown. These are the paths a browser can reach with a project id, so they
// are the ones worth proving rather than reasoning about.
// Run: pnpm test:fs
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DATA = process.env.DAEDALUS_DATA_DIR!;
rmSync(DATA, { recursive: true, force: true });

const { createProject, deleteProject } = await import("../src/projects.js");
const fs = await import("../src/workspace-fs.js");
const { watchProject, stopWatching, watchedProjects } = await import("../src/workspace-watch.js");
const terminals = await import("../src/terminals.js");
const git = await import("../src/git.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/** The status a WorkspaceError carries, or the error re-thrown. */
async function status(fn: () => unknown | Promise<unknown>): Promise<number> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof fs.WorkspaceError) return err.status;
    throw err;
  }
  throw new Error("expected a refusal, got a result");
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "daedalus-ws-"));
const outside = mkdtempSync(join(tmpdir(), "daedalus-out-"));
writeFileSync(join(outside, "secret.txt"), "not yours");

mkdirSync(join(root, "src"));
mkdirSync(join(root, "node_modules"));
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "src", "index.ts"), "export const x = 1\n");
writeFileSync(join(root, "README.md"), "# hello\n");
writeFileSync(join(root, ".env"), "SECRET=1\n");
writeFileSync(join(root, "node_modules", "junk.js"), "//\n");
writeFileSync(join(root, "binary.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
symlinkSync(outside, join(root, "escape"), "dir");
symlinkSync(join(root, "src"), join(root, "inside-link"), "dir");

const project = createProject({
  name: "ws",
  cwd: root,
  description: null,
});

// ── Containment ──────────────────────────────────────────────────────────────
await test("relative paths resolve inside the project", () => {
  const resolved = fs.resolveInProject(root, "src/index.ts");
  assert.equal(resolved, join(root, "src", "index.ts"));
  assert.equal(fs.resolveInProject(root, ""), root);
  assert.equal(fs.resolveInProject(root, "."), root);
});

await test("traversal is refused", async () => {
  assert.equal(await status(() => fs.resolveInProject(root, "../")), 403);
  assert.equal(await status(() => fs.resolveInProject(root, "../../etc/passwd")), 403);
  assert.equal(await status(() => fs.resolveInProject(root, "src/../../out")), 403);
});

await test("absolute paths are refused, not re-rooted", async () => {
  assert.equal(await status(() => fs.resolveInProject(root, "/etc/passwd")), 400);
  assert.equal(await status(() => fs.resolveInProject(root, "C:\\Windows")), 400);
});

await test("a symlink out of the project is not readable", async () => {
  assert.equal(await status(() => fs.resolveInProject(root, "escape")), 403);
  assert.equal(await status(() => fs.resolveInProject(root, "escape/secret.txt")), 403);
  assert.equal(await status(() => fs.readFile(project.id, "escape/secret.txt")), 403);
});

await test("a symlink inside the project still works", () => {
  const resolved = fs.resolveInProject(root, "inside-link/index.ts");
  assert.ok(resolved.startsWith(root));
});

await test("a path that does not exist yet is checked against its parent", async () => {
  // The write would land in `src`, which is inside — allowed.
  assert.ok(fs.resolveInProject(root, "src/new-file.ts").startsWith(root));
  // This one would land outside through the link — refused before anything is
  // created, which is the point of walking up to the nearest existing ancestor.
  assert.equal(await status(() => fs.resolveInProject(root, "escape/new-file.ts")), 403);
});

await test("a project rooted at a symlink is not its own escape", async () => {
  const linked = join(tmpdir(), `daedalus-link-${process.pid}`);
  rmSync(linked, { force: true });
  symlinkSync(root, linked, "dir");
  const viaLink = createProject({
    name: "linked",
    cwd: linked,
    description: null,
  });
  const listing = await fs.listDir(viaLink.id, "src");
  assert.ok(listing.entries.some((entry) => entry.name === "index.ts"));
  deleteProject(viaLink.id);
  rmSync(linked, { force: true });
});

// ── Listing ──────────────────────────────────────────────────────────────────
await test("listing hides ignored and hidden entries by default", async () => {
  const listing = await fs.listDir(project.id, "");
  const names = listing.entries.map((entry) => entry.name);
  assert.ok(names.includes("src"));
  assert.ok(names.includes("README.md"));
  assert.ok(!names.includes("node_modules"), "node_modules is ignored by default");
  assert.ok(!names.includes(".git"), ".git is ignored by default");
  assert.ok(!names.includes(".env"), "dotfiles are hidden by default");
  // Directories first, then files, each alphabetical.
  const types = listing.entries.map((entry) => entry.type);
  assert.deepEqual([...types].sort((a, b) => (a === b ? 0 : a === "dir" ? -1 : 1)), types);
});

await test("hidden and ignored can be revealed", async () => {
  const names = (
    await fs.listDir(project.id, "", { hidden: true, ignored: true })
  ).entries.map((entry) => entry.name);
  assert.ok(names.includes(".env"));
  assert.ok(names.includes("node_modules"));
  const env = (
    await fs.listDir(project.id, "", { hidden: true })
  ).entries.find((entry) => entry.name === ".env");
  assert.equal(env?.hidden, true);
});

await test("paths in a listing are relative, never absolute", async () => {
  for (const entry of (await fs.listDir(project.id, "src")).entries) {
    assert.ok(!entry.path.startsWith("/"), `${entry.path} is absolute`);
    assert.ok(!entry.path.includes(root), `${entry.path} leaks the server path`);
  }
  assert.equal((await fs.listDir(project.id, "src")).entries[0]?.path, "src/index.ts");
});

await test("a listing is bounded and says when it was cut", async () => {
  const many = join(root, "many");
  mkdirSync(many);
  for (let i = 0; i < 1100; i += 1) writeFileSync(join(many, `f${i}.txt`), "x");
  const listing = await fs.listDir(project.id, "many");
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries.length, 1000);
  rmSync(many, { recursive: true });
});

await test("listing a file is a 400, listing nothing is a 404", async () => {
  assert.equal(await status(() => fs.listDir(project.id, "README.md")), 400);
  assert.equal(await status(() => fs.listDir(project.id, "nope")), 404);
  assert.equal(await status(() => fs.listDir("no-such-project", "")), 404);
});

// ── Reading ──────────────────────────────────────────────────────────────────
await test("a text file comes back with its content and a version", async () => {
  const file = await fs.readFile(project.id, "README.md");
  assert.equal(file.content, "# hello\n");
  assert.equal(file.binary, false);
  assert.equal(file.tooLarge, false);
  assert.ok(file.version);
  assert.equal(file.path, "README.md");
});

await test("a binary file is described, not decoded", async () => {
  const file = await fs.readFile(project.id, "binary.bin");
  assert.equal(file.binary, true);
  assert.equal(file.content, undefined);
});

await test("an oversized file is described, not read", async () => {
  const big = join(root, "big.txt");
  writeFileSync(big, "a".repeat(fs.MAX_READ_BYTES + 1));
  const file = await fs.readFile(project.id, "big.txt");
  assert.equal(file.tooLarge, true);
  assert.equal(file.content, undefined);
  assert.ok(file.size > fs.MAX_READ_BYTES);
  rmSync(big);
});

await test("file-stat answers without reading the bytes", async () => {
  const stat = await fs.statFile(project.id, "src");
  assert.equal(stat.type, "dir");
  const file = await fs.statFile(project.id, "README.md");
  assert.equal(file.type, "file");
  assert.equal(file.binary, false);
});

// ── Writing ──────────────────────────────────────────────────────────────────
await test("a write is atomic and leaves no temp file behind", () => {
  const before = readdirSync(root).length;
  fs.writeFile(project.id, "src/written.ts", "const a = 1\n");
  assert.equal(readFileSync(join(root, "src", "written.ts"), "utf8"), "const a = 1\n");
  assert.equal(readdirSync(root).length, before, "no stray temp file in the root");
  assert.ok(!readdirSync(join(root, "src")).some((name) => name.includes(".tmp")));
});

await test("a stale write is a conflict, not an overwrite", async () => {
  const first = await fs.readFile(project.id, "src/written.ts");
  fs.writeFile(project.id, "src/written.ts", "changed by someone else\n");
  assert.equal(
    await status(() =>
      fs.writeFile(project.id, "src/written.ts", "mine\n", { expectedVersion: first.version }),
    ),
    409,
  );
  // The other writer's content survived the refusal.
  assert.equal(
    readFileSync(join(root, "src", "written.ts"), "utf8"),
    "changed by someone else\n",
  );
});

await test("force is how the user overrides a conflict", () => {
  const written = fs.writeFile(project.id, "src/written.ts", "mine\n", {
    expectedVersion: "nonsense",
    force: true,
  });
  assert.equal(readFileSync(join(root, "src", "written.ts"), "utf8"), "mine\n");
  assert.ok(written.version);
});

await test("the version a write returns is the one the next write expects", () => {
  const first = fs.writeFile(project.id, "src/chain.ts", "1\n");
  const second = fs.writeFile(project.id, "src/chain.ts", "2\n", {
    expectedVersion: first.version,
  });
  assert.notEqual(first.version, second.version);
  assert.equal(readFileSync(join(root, "src", "chain.ts"), "utf8"), "2\n");
});

await test("writes are bounded and cannot escape", async () => {
  assert.equal(
    await status(() => fs.writeFile(project.id, "big.txt", "a".repeat(fs.MAX_WRITE_BYTES + 1))),
    413,
  );
  assert.equal(await status(() => fs.writeFile(project.id, "escape/x.txt", "x")), 403);
  assert.equal(await status(() => fs.writeFile(project.id, "../x.txt", "x")), 403);
  assert.equal(await status(() => fs.writeFile(project.id, "src", "x")), 400);
});

// ── Create, rename, delete ───────────────────────────────────────────────────
await test("create refuses to clobber and refuses the root", async () => {
  const made = fs.createEntry(project.id, "src/fresh.ts", "file");
  assert.equal(made.path, "src/fresh.ts");
  assert.equal(await status(() => fs.createEntry(project.id, "src/fresh.ts", "file")), 409);
  assert.equal(await status(() => fs.createEntry(project.id, "", "dir")), 400);
  fs.createEntry(project.id, "made/deep", "dir");
  assert.equal((await fs.statFile(project.id, "made/deep")).type, "dir");
});

await test("rename moves inside the project only", async () => {
  const renamed = fs.renameEntry(project.id, "src/fresh.ts", "src/renamed.ts");
  assert.equal(renamed.path, "src/renamed.ts");
  assert.equal(await status(() => fs.renameEntry(project.id, "src/renamed.ts", "../out.ts")), 403);
  assert.equal(await status(() => fs.renameEntry(project.id, "src/renamed.ts", "README.md")), 409);
  assert.equal(await status(() => fs.renameEntry(project.id, "src/missing.ts", "src/x.ts")), 404);
});

await test("delete refuses the root and reports a missing target", async () => {
  assert.equal(await status(() => fs.deleteEntry(project.id, "")), 400);
  assert.equal(await status(() => fs.deleteEntry(project.id, "nope")), 404);
  fs.deleteEntry(project.id, "src/renamed.ts");
  assert.equal(await status(() => fs.statFile(project.id, "src/renamed.ts")), 404);
  // The escape link itself cannot be removed through here either — resolving it
  // lands outside, which is refused before anything is unlinked.
  assert.equal(await status(() => fs.deleteEntry(project.id, "escape")), 403);
});

// ── Watcher ─────────────────────────────────────────────────────────────────
await test("the watcher batches events and refcounts its handle", async () => {
  const batches: unknown[] = [];
  const off = watchProject(project.id, (batch) => batches.push(batch));
  const off2 = watchProject(project.id, () => {});
  assert.deepEqual(watchedProjects(), [project.id], "both subscribers share one watcher");

  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `watched-${i}.txt`), "x");
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(batches.length >= 1, "something was reported");
  assert.ok(batches.length < 5, `five writes did not become ${batches.length} batches`);

  off();
  assert.deepEqual(watchedProjects(), [project.id], "one subscriber left, watcher stays");
  off2();
  assert.deepEqual(watchedProjects(), [], "last subscriber closed the watcher");
});

await test("watching an unknown project refuses instead of watching nothing", async () => {
  assert.equal(await status(() => watchProject("no-such-project", () => {})), 404);
});

// ── Git ─────────────────────────────────────────────────────────────────────
await test("a non-repository is a normal answer, not a failure", async () => {
  const plain = await git.status(project.id);
  assert.equal(plain.repository, false);
  assert.deepEqual(plain.staged, []);
  // Every write refuses with a 400 rather than running git somewhere upward.
  assert.equal(await status(() => git.stage(project.id, ["README.md"])), 400);
  assert.equal(await status(() => git.commit(project.id, "nope")), 400);
});

await test("trees: a snapshot sees shell edits and untracked files, and a hunk applies", async () => {
  const repo = mkdtempSync(join(tmpdir(), "daedalus-trees-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "first"]);
  const project = createProject({ name: "trees", cwd: repo, description: null });

  const dir = await git.repoDirAt(repo);
  assert.equal(dir, repo);
  const before = await git.snapshotTree(repo);
  /* Not through any tool: the way a `sed` in a shell changes a file. */
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(repo, "new.txt"), "fresh\n");
  const after = await git.snapshotTree(repo);
  assert.notEqual(before, after);
  /* The real index was never touched. */
  assert.equal(run(["diff", "--cached", "--name-only"]).trim(), "");

  const files = await git.diffTrees(repo, before, after);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions]),
    [["a.txt", "modified", 1, 1], ["new.txt", "added", 1, 0]],
  );
  const patch = await git.patchBetween(repo, before, after, "a.txt");
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/);
  assert.match(patch, /-two\n\+TWO/);

  /* Staging one hunk from the patch: it lands in the index and not beyond. */
  await git.applyPatch(project.id, patch, { cached: true });
  assert.equal(run(["diff", "--cached", "--name-only"]).trim(), "a.txt");
  /* And reversing it on the worktree puts the file back. */
  await git.applyPatch(project.id, patch, { reverse: true });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(await git.hasObject(repo, before), true);
  assert.equal(await git.hasObject(repo, "0".repeat(40)), false);
  deleteProject(project.id);
});

await test("status parses porcelain v2, including renames and untracked", async () => {
  const repo = mkdtempSync(join(tmpdir(), "daedalus-git-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "kept.txt"), "one\n");
  writeFileSync(join(repo, "moved.txt"), "two\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "first"]);

  const gitProject = createProject({
    name: "git",
    cwd: repo,
    description: null,
  });

  writeFileSync(join(repo, "kept.txt"), "one changed\n");
  run(["mv", "moved.txt", "renamed.txt"]);
  writeFileSync(join(repo, "fresh.txt"), "new\n");

  const s1 = await git.status(gitProject.id);
  assert.equal(s1.repository, true);
  assert.equal(s1.branch, "main");
  assert.equal(s1.unborn, false);
  assert.ok(s1.unstaged.some((f) => f.path === "kept.txt"), "modified file is unstaged");
  assert.ok(s1.untracked.some((f) => f.path === "fresh.txt"), "new file is untracked");
  const rename = s1.staged.find((f) => f.index === "renamed");
  assert.ok(rename, "the rename is staged");
  assert.equal(rename.path, "renamed.txt");
  assert.equal(rename.from, "moved.txt", "the rename's source came from the paired record");

  // The record after a rename must still parse — this is the off-by-one that a
  // naive split on NUL produces, and it corrupts every entry after it.
  assert.ok(
    s1.untracked.every((f) => f.path && !f.path.includes("\u0000")),
    "records after the rename are intact",
  );

  // Stage → commit → clean.
  await git.stage(gitProject.id, []);
  const staged = await git.status(gitProject.id);
  assert.ok(staged.staged.length >= 3);
  assert.deepEqual(staged.untracked, []);
  const { output } = await git.commit(gitProject.id, "second");
  assert.ok(output.length > 0, "git's own output is passed through");
  const clean = await git.status(gitProject.id);
  assert.deepEqual(clean.staged, []);
  assert.deepEqual(clean.unstaged, []);

  // Branches, including a name with a slash in it.
  await git.checkout(gitProject.id, "feature/thing", { create: true });
  const list = await git.branches(gitProject.id);
  assert.equal(list.current, "feature/thing");
  assert.ok(list.branches.includes("main"));

  /* A "branch name" that is really a flag is refused before git runs. Without
     the check, `git checkout --force --` parses --force as checkout's own flag
     and throws away the working tree — the `--` is after it, not before. */
  assert.equal(await status(() => git.checkout(gitProject.id, "--force")), 400);
  assert.equal(await status(() => git.checkout(gitProject.id, "-B", { create: true })), 400);
  assert.equal(
    (await git.branches(gitProject.id)).current,
    "feature/thing",
    "the refused checkout changed nothing",
  );

  // The other side of a comparison.
  await git.checkout(gitProject.id, "main");
  const head = await git.fileAt(gitProject.id, "kept.txt", "head");
  assert.equal(head.content, "one changed\n");
  const gone = await git.fileAt(gitProject.id, "never-existed.txt", "head");
  assert.equal(gone.missing, true, "a file absent on that side is not an error");

  deleteProject(gitProject.id);
  rmSync(repo, { recursive: true, force: true });
});

await test("discard refuses an empty path list", async () => {
  assert.equal(await status(() => git.discard(project.id, [])), 400);
});

await test("a project that is a folder of repositories, not one", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "daedalus-multi-"));
  const init = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
    run(["init", "--quiet", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    run(["add", "."]);
    run(["commit", "--quiet", "-m", "first"]);
    return run;
  };

  // The project root itself is not a repository; two of its subdirectories are,
  // one of them a level down.
  const alpha = init(join(workspace, "alpha"));
  init(join(workspace, "nested", "beta"));
  // A repository buried inside another one is not offered: what is under a
  // checkout is that checkout's business.
  init(join(workspace, "alpha", "vendor", "inner"));
  mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(workspace, "node_modules", "pkg", ".git"), { recursive: true });

  const multi = createProject({ name: "multi", cwd: workspace, description: null });

  const repos = await git.repositories(multi.id);
  const paths = repos.map((r) => r.path).sort();
  assert.deepEqual(paths, ["alpha", "nested/beta"], "found both, and only those");
  assert.equal(repos.find((r) => r.path === "alpha")?.branch, "main");

  // Without a repo the project answers "not a repository" — the subdirectories
  // are repositories, the project is not.
  assert.equal((await git.status(multi.id)).repository, false);

  writeFileSync(join(workspace, "alpha", "seed.txt"), "changed\n");
  writeFileSync(join(workspace, "alpha", "extra.txt"), "new\n");
  const inAlpha = await git.status(multi.id, "alpha");
  assert.equal(inAlpha.repository, true);
  assert.equal(inAlpha.repo, "alpha", "the status says which repository it is");
  assert.ok(
    inAlpha.unstaged.some((f) => f.path === "seed.txt"),
    "paths are relative to the repository, not the project",
  );

  // Staging, committing and reading a revision all land in that repository.
  await git.stage(multi.id, [], "alpha");
  const alphaStaged = (await git.status(multi.id, "alpha")).staged.map((f) => f.path);
  // `vendor/inner` is staged too, as the gitlink git records for an embedded
  // repository — that is git's own behaviour, not the panel's.
  assert.ok(["extra.txt", "seed.txt"].every((p) => alphaStaged.includes(p)));
  await git.commit(multi.id, "in alpha", { repo: "alpha" });
  assert.deepEqual((await git.status(multi.id, "alpha")).staged, []);
  assert.equal(
    (await git.fileAt(multi.id, "alpha/seed.txt", "head")).content,
    "changed\n",
    "a revision is read from the repository that owns the file",
  );
  // The other repository was not touched by any of it.
  assert.equal(alpha(["rev-list", "--count", "HEAD"]).trim(), "2");
  assert.deepEqual((await git.status(multi.id, "nested/beta")).unstaged, []);

  // A directory that is not a repository root is refused rather than answered
  // with the enclosing repository's status under a path prefix that is a lie.
  assert.equal(await status(() => git.status(multi.id, "alpha/vendor")), 400);
  assert.equal(await status(() => git.stage(multi.id, ["x"], "nested")), 400);
  // And the ordinary containment rule still applies to a client-supplied path.
  assert.equal(await status(() => git.status(multi.id, "../..")), 403);

  deleteProject(multi.id);
  rmSync(workspace, { recursive: true, force: true });
});

await test("a project inside a larger repository sees only its own subtree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "daedalus-nested-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  writeFileSync(join(repo, "packages", "app", "index.ts"), "export {}\n");
  writeFileSync(join(repo, "top.txt"), "top\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "first"]);

  const inner = createProject({
    name: "app",
    cwd: join(repo, "packages", "app"),
    description: null,
  });

  writeFileSync(join(repo, "packages", "app", "index.ts"), "export const a = 1\n");
  writeFileSync(join(repo, "top.txt"), "touched\n");

  const s = await git.status(inner.id);
  assert.equal(s.repository, true);
  assert.equal(s.repo, "", "the repository the project belongs to is its own");
  assert.deepEqual(
    s.unstaged.map((f) => f.path),
    ["index.ts"],
    "the prefix is stripped, and the change above the project is not listed",
  );

  // "Stage everything" means everything this panel listed, not the whole
  // repository — `git add --all` alone would have taken top.txt with it.
  await git.stage(inner.id, []);
  const staged = await git.status(inner.id);
  assert.deepEqual(staged.staged.map((f) => f.path), ["index.ts"]);
  assert.equal(
    run(["diff", "--name-only", "--cached"]).trim(),
    "packages/app/index.ts",
    "nothing above the project was staged",
  );

  assert.equal(
    (await git.fileAt(inner.id, "index.ts", "head")).content,
    "export {}\n",
    "a revision resolves relative to the project directory",
  );

  await git.unstage(inner.id, []);
  assert.equal(run(["diff", "--name-only", "--cached"]).trim(), "");

  deleteProject(inner.id);
  rmSync(repo, { recursive: true, force: true });
});

// ── Terminals ────────────────────────────────────────────────────────────────
await test("a terminal runs in the project directory and is bounded per project", async () => {
  const created = terminals.createTerminal(project.id, { cols: 100, rows: 30 });
  assert.equal(created.projectId, project.id);
  assert.equal(created.cols, 100);
  assert.equal(created.exitCode, null);
  assert.equal(terminals.listTerminals(project.id).length, 1);

  // The cap is per project, and the refusal is a 409 rather than a silent
  // eighth terminal that nothing owns.
  for (let i = 1; i < 8; i += 1) terminals.createTerminal(project.id);
  assert.equal(await status(() => terminals.createTerminal(project.id)), 409);
  assert.equal(terminals.listTerminals(project.id).length, 8);
});

await test("terminals are refused for a project that does not exist", async () => {
  assert.equal(await status(() => terminals.createTerminal("no-such-project")), 404);
  assert.deepEqual(terminals.listTerminals("no-such-project"), []);
});

await test("killing is explicit, and killing a project takes all of its terminals", () => {
  const [first] = terminals.listTerminals(project.id);
  assert.equal(terminals.killTerminal(first.id), true);
  assert.equal(terminals.killTerminal(first.id), false, "killing twice is not an error, just false");
  assert.equal(terminals.listTerminals(project.id).length, 7);

  assert.equal(terminals.killProjectTerminals(project.id), 7);
  assert.deepEqual(terminals.listTerminals(project.id), []);
});

// ── Teardown ─────────────────────────────────────────────────────────────────
terminals.killProjectTerminals();
stopWatching();
deleteProject(project.id);
rmSync(root, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`workspace-fs: ${passed} passed`);

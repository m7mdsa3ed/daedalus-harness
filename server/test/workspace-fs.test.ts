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
const previews = await import("../src/previews.js");

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
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
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

await test("a project rooted at a symlink is not its own escape", () => {
  const linked = join(tmpdir(), `daedalus-link-${process.pid}`);
  rmSync(linked, { force: true });
  symlinkSync(root, linked, "dir");
  const viaLink = createProject({
    name: "linked",
    cwd: linked,
    description: null,
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
  });
  const listing = fs.listDir(viaLink.id, "src");
  assert.ok(listing.entries.some((entry) => entry.name === "index.ts"));
  deleteProject(viaLink.id);
  rmSync(linked, { force: true });
});

// ── Listing ──────────────────────────────────────────────────────────────────
await test("listing hides ignored and hidden entries by default", () => {
  const listing = fs.listDir(project.id, "");
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

await test("hidden and ignored can be revealed", () => {
  const names = fs
    .listDir(project.id, "", { hidden: true, ignored: true })
    .entries.map((entry) => entry.name);
  assert.ok(names.includes(".env"));
  assert.ok(names.includes("node_modules"));
  const env = fs
    .listDir(project.id, "", { hidden: true })
    .entries.find((entry) => entry.name === ".env");
  assert.equal(env?.hidden, true);
});

await test("paths in a listing are relative, never absolute", () => {
  for (const entry of fs.listDir(project.id, "src").entries) {
    assert.ok(!entry.path.startsWith("/"), `${entry.path} is absolute`);
    assert.ok(!entry.path.includes(root), `${entry.path} leaks the server path`);
  }
  assert.equal(fs.listDir(project.id, "src").entries[0]?.path, "src/index.ts");
});

await test("a listing is bounded and says when it was cut", () => {
  const many = join(root, "many");
  mkdirSync(many);
  for (let i = 0; i < 1100; i += 1) writeFileSync(join(many, `f${i}.txt`), "x");
  const listing = fs.listDir(project.id, "many");
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

// ── Previews ─────────────────────────────────────────────────────────────────
await test("a preview URL is validated before it is ever stored", async () => {
  // The panel puts a stored URL straight into an iframe, so a `javascript:` or
  // `data:` one would be stored XSS with the app's own origin behind it.
  assert.equal(await status(() => previews.createPreview(project.id, null, "javascript:alert(1)")), 400);
  assert.equal(await status(() => previews.createPreview(project.id, null, "data:text/html,<script>")), 400);
  assert.equal(await status(() => previews.createPreview(project.id, null, "file:///etc/passwd")), 400);
  assert.equal(await status(() => previews.createPreview(project.id, null, "")), 400);
  assert.equal(await status(() => previews.createPreview("no-such-project", null, "http://x")), 404);
});

await test("a bare host:port is assumed http rather than rejected", () => {
  // "localhost:5173" is what people type, and the URL parser reads "localhost"
  // as the scheme unless something puts one in front.
  assert.equal(previews.normalizePreviewUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(previews.normalizePreviewUrl("https://example.test/x"), "https://example.test/x");
});

await test("previews round-trip and go with their project", () => {
  const made = previews.createPreview(project.id, "Dev", "localhost:3000");
  assert.equal(made.url, "http://localhost:3000/");
  assert.equal(made.label, "Dev");
  const unlabelled = previews.createPreview(project.id, null, "http://example.test:8080/app");
  assert.equal(unlabelled.label, "example.test:8080", "the host is the fallback label");
  assert.equal(previews.listPreviews(project.id).length, 2);
  assert.equal(previews.deletePreview(made.id), true);
  assert.equal(previews.deletePreview(made.id), false);
  assert.equal(previews.listPreviews(project.id).length, 1);
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
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
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

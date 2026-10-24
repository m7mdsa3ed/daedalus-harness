// Self-check for the file-mirror half of the saved-workflow library
// (src/workflows/saved.ts), against a temp dir and a fake meta reader — no
// database, no sandbox:
//   - file names are safe, stable and collision-free
//   - containment (isInside, readScriptPath) refuses `..`, absolute escapes and
//     a symlink pointing out
//   - writeMirrorFile writes 0644, appends a newline, refuses a symlinked dir/file
//   - scanDirectory reads good files and names bad/oversized/linked ones
//   - removeMirrorFiles deletes by meta name; makeThrottle spaces calls
// Run: pnpm exec tsx test/workflow-saved.test.ts (with DAEDALUS_DATA_DIR set)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  isInside,
  makeThrottle,
  mirrorFileName,
  readScriptPath,
  refuseSymlinks,
  removeMirrorFiles,
  scanDirectory,
  versionOf,
  workflowDir,
  writeMirrorFile,
} = await import("../src/workflows/saved.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads `// name: x` — the shape of the real parser is not under test. */
const readMeta = (source: string) => {
  const m = /^\/\/ name: (\S+)/m.exec(source);
  if (!m) throw new Error("no meta");
  return { name: m[1]!, description: "d", phases: [] };
};
const script = (name: string, body = "") => `// name: ${name}\n${body}`;

const root = await mkdtemp(join(tmpdir(), "wf-saved-"));
const project = join(root, "project");
const outside = join(root, "outside");
await mkdir(project, { recursive: true });
await mkdir(outside, { recursive: true });

await test("mirrorFileName keeps safe names and hashes unsafe ones apart", () => {
  assert.equal(mirrorFileName("review"), "review.js");
  assert.equal(mirrorFileName("a_b.c-d"), "a_b.c-d.js");
  const a = mirrorFileName("my flow");
  const b = mirrorFileName("my/flow");
  assert.match(a, /^my-flow-[0-9a-f]{6}\.js$/);
  assert.notEqual(a, b);
  assert.match(mirrorFileName("../../etc/passwd"), /^etc-passwd-[0-9a-f]{6}\.js$/);
  assert.ok(!mirrorFileName("../x").includes("/"));
  assert.match(mirrorFileName("日本語"), /^workflow-[0-9a-f]{6}\.js$/);
  assert.equal(mirrorFileName("my flow"), a);
});

await test("versionOf is 16 hex of sha256", () => {
  assert.match(versionOf("x"), /^[0-9a-f]{16}$/);
  assert.notEqual(versionOf("x"), versionOf("y"));
});

await test("workflowDir picks the project and personal directories", () => {
  assert.equal(workflowDir("project", "/p", "/h"), "/p/.claude/workflows");
  assert.equal(workflowDir("personal", "/p", "/h"), "/h/workflows");
  assert.equal(workflowDir("project", null, "/h"), null);
});

await test("isInside is lexical containment", () => {
  assert.ok(isInside("/a/b", "/a/b"));
  assert.ok(isInside("/a/b", "/a/b/c/d.js"));
  assert.ok(!isInside("/a/b", "/a/bc"));
  assert.ok(!isInside("/a/b", "/a"));
  assert.ok(!isInside("/a/b", "/a/b/../c"));
});

await test("writeMirrorFile writes 0644 with a trailing newline and overwrites", async () => {
  const dir = join(project, ".claude", "workflows");
  const p = await writeMirrorFile(dir, "one.js", script("one"), [join(project, ".claude")]);
  assert.equal(await readFile(p, "utf8"), "// name: one\n");
  assert.equal((await stat(p)).mode & 0o777, 0o644);
  await writeMirrorFile(dir, "one.js", script("one", "x\n"));
  assert.equal(await readFile(p, "utf8"), "// name: one\nx\n");
});

await test("writeMirrorFile refuses a symlinked file, directory and guard", async () => {
  const dir = join(project, ".claude", "workflows");
  await writeFile(join(outside, "target.js"), "keep");
  await symlink(join(outside, "target.js"), join(dir, "linked.js"));
  await assert.rejects(writeMirrorFile(dir, "linked.js", script("linked")), /symlink/);
  assert.equal(await readFile(join(outside, "target.js"), "utf8"), "keep");

  await symlink(outside, join(root, "linkdir"));
  await assert.rejects(writeMirrorFile(join(root, "linkdir"), "x.js", script("x")), /symlink/);
  await assert.rejects(writeMirrorFile(dir, "ok.js", script("ok"), [join(root, "linkdir")]), /symlink/);
  await refuseSymlinks([join(root, "does-not-exist")]);
});

await test("scanDirectory reads good files and names the rest", async () => {
  const dir = join(root, "scan");
  await mkdir(dir);
  await writeFile(join(dir, "a.js"), script("alpha"));
  await writeFile(join(dir, "b.js"), "no meta here");
  await writeFile(join(dir, "big.js"), script("big", "x".repeat(200)));
  await writeFile(join(dir, "notes.txt"), script("ignored"));
  await symlink(join(outside, "target.js"), join(dir, "l.js"));
  await mkdir(join(dir, "d.js"));
  const r = await scanDirectory(dir, readMeta, { maxBytes: 100 });
  assert.deepEqual(r.found.map((f) => f.meta.name), ["alpha"]);
  assert.equal(r.skipped.length, 4);
  assert.ok(r.skipped.some((s) => s.includes("b.js") && s.includes("no meta")));
  assert.ok(r.skipped.some((s) => s.includes("big.js") && s.includes("larger")));
  assert.ok(r.skipped.some((s) => s.includes("l.js") && s.includes("symlink")));
  assert.ok(r.skipped.some((s) => s.includes("d.js")));
  const followed = await scanDirectory(dir, (s) => ({ name: "t", description: "", phases: [] }), { followSymlinks: true, maxBytes: 100 });
  assert.ok(followed.found.some((f) => f.file === "l.js"));
  assert.deepEqual((await scanDirectory(join(root, "missing"), readMeta)).found, []);
});

await test("readScriptPath reads inside roots and refuses escapes", async () => {
  await mkdir(join(project, "wf"), { recursive: true });
  await writeFile(join(project, "wf", "s.js"), "ok");
  assert.equal(await readScriptPath("wf/s.js", project, [project]), "ok");
  assert.equal(await readScriptPath(join(project, "wf", "s.js"), outside, [project]), "ok");
  await assert.rejects(readScriptPath("../outside/target.js", project, [project]), /outside/);
  await assert.rejects(readScriptPath(join(outside, "target.js"), project, [project]), /outside/);
  await symlink(join(outside, "target.js"), join(project, "wf", "out.js"));
  await assert.rejects(readScriptPath("wf/out.js", project, [project]), /outside/);
  await assert.rejects(readScriptPath("wf/missing.js", project, [project]), /cannot read/);
  await assert.rejects(readScriptPath("wf", project, [project]), /not a file/);
  await writeFile(join(project, "wf", "big.js"), "x".repeat(50));
  await assert.rejects(readScriptPath("wf/big.js", project, [project], 10), /larger/);
});

await test("removeMirrorFiles deletes files by meta name only", async () => {
  const dir = join(root, "rm");
  await mkdir(dir);
  await writeFile(join(dir, "x.js"), script("gone"));
  await writeFile(join(dir, "y.js"), script("stays"));
  const removed = await removeMirrorFiles(dir, "gone", readMeta);
  assert.equal(removed.length, 1);
  assert.deepEqual((await scanDirectory(dir, readMeta)).found.map((f) => f.meta.name), ["stays"]);
});

await test("makeThrottle admits one call per window per key", () => {
  let t = 1000;
  const th = makeThrottle(30_000, () => t);
  assert.ok(th.take("a"));
  assert.ok(!th.take("a"));
  assert.ok(th.take("b"));
  t += 29_999;
  assert.ok(!th.take("a"));
  t += 1;
  assert.ok(th.take("a"));
  th.reset("a");
  assert.ok(th.take("a"));
});

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);

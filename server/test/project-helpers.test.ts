import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "daedalus-test-helpers-"));
process.env.DAEDALUS_DATA_DIR = dir;

const { createProject } = await import("../src/projects.js");
const { db, projectHelpers: helpersTable } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");
const {
  addHelper,
  deleteHelper,
  getHelper,
  helpersByProject,
  listHelpers,
  updateHelper,
} = await import("../src/project-helpers.js");
const { containedPath } = await import("../src/workspace-fs.js");

try {
  mkdirSync(join(dir, "sub"));
  const p1 = createProject({ name: "P1", cwd: dir, description: null });
  const p2 = createProject({ name: "P2", cwd: dir, description: null });

  // 1. Initially empty
  assert.deepEqual(listHelpers(p1.id), []);

  // 2. Add
  const h1 = addHelper(p1.id, { name: "Restart server", command: "echo restarted" });
  assert.equal(h1.name, "Restart server");
  assert.equal(h1.command, "echo restarted");
  assert.equal(h1.projectId, p1.id);
  // Fields the input left out come back as their empty shapes, not undefined.
  assert.equal(h1.cwd, null);
  assert.equal(h1.env, null);
  assert.equal(h1.description, null);
  assert.equal(h1.confirm, false);

  // Every optional field round-trips, and an add+delete leaves counts alone.
  const h1b = addHelper(p1.id, {
    name: "Risk",
    command: "echo risky",
    cwd: "sub",
    env: { K: "v", "empty-key": "" },
    description: "The risky one",
    confirm: true,
  });
  const stored = getHelper(p1.id, h1b.id);
  assert.equal(stored?.cwd, "sub");
  assert.deepEqual(stored?.env, { K: "v", "empty-key": "" });
  assert.equal(stored?.description, "The risky one");
  assert.equal(stored?.confirm, true);
  assert.equal(deleteHelper(p1.id, h1b.id), true);

  const h2 = addHelper(p1.id, { name: "Migrate", command: "echo migrated" });
  const forP1 = listHelpers(p1.id);
  assert.equal(forP1.length, 2);
  const names = forP1.map((h) => h.name).sort();
  assert.deepEqual(names, ["Migrate", "Restart server"]);

  // 3. Project isolation
  assert.deepEqual(listHelpers(p2.id), []);
  const byProject = helpersByProject([p1.id, p2.id]);
  assert.equal(byProject.get(p1.id)?.length, 2);
  assert.equal(byProject.get(p2.id), undefined);

  // 4. Update — options set, then cleared when the input leaves them out
  const updated = updateHelper(p1.id, h1.id, {
    name: "Restart backend",
    command: "echo ok",
    cwd: "sub",
    description: "Restarts",
    confirm: true,
  });
  assert.equal(updated?.name, "Restart backend");
  assert.equal(updated?.cwd, "sub");
  assert.equal(updated?.confirm, true);
  assert.equal(getHelper(p1.id, h1.id)?.name, "Restart backend");

  const cleared = updateHelper(p1.id, h1.id, { name: "Restart backend", command: "echo ok" });
  assert.equal(cleared?.cwd, null);
  assert.equal(cleared?.env, null);
  assert.equal(cleared?.description, null);
  assert.equal(cleared?.confirm, false);

  /* 5. A helper's stored `cwd` is clamped into the project rather than
        refused, since it is read by a spawn and not by a route. */
  const root = join(dir, "sub");
  mkdirSync(join(root, "nested"));
  assert.equal(containedPath(root, null), root);
  assert.equal(containedPath(root, ""), root);
  assert.equal(containedPath(root, "."), root);
  assert.equal(containedPath(root, "nested"), join(root, "nested"));
  // Names a directory that does not exist yet — the spawn's ENOENT is the
  // honest answer, so it is resolved rather than swallowed back to the root.
  assert.equal(containedPath(root, "not-yet"), join(root, "not-yet"));

  // 6. Climbing out, an absolute path, and a symlink pointing away all clamp
  assert.equal(containedPath(root, "../.."), root);
  assert.equal(containedPath(root, "nested/../../.."), root);
  assert.equal(containedPath(root, tmpdir()), root);
  assert.equal(containedPath(root, "C:\\Windows"), root);
  symlinkSync(tmpdir(), join(root, "escape"));
  assert.equal(containedPath(root, "escape"), root);

  // 7. An env text a hand mangled degrades to "no extra env", not a crash
  db.update(helpersTable).set({ env: "not json" }).where(eq(helpersTable.id, h1.id)).run();
  assert.equal(getHelper(p1.id, h1.id)?.env, null);
  db.update(helpersTable).set({ env: null }).where(eq(helpersTable.id, h1.id)).run();

  // 8. Delete
  assert.equal(deleteHelper(p1.id, h1.id), true);
  assert.equal(listHelpers(p1.id).length, 1);
  assert.equal(getHelper(p1.id, h1.id), undefined);

  console.log("project-helpers: 8 passed, 0 failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

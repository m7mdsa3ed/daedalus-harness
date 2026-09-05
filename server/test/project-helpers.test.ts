import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "daedalus-test-helpers-"));
process.env.DAEDALUS_DATA_DIR = dir;

const { createProject } = await import("../src/projects.js");
const {
  addHelper,
  deleteHelper,
  getHelper,
  helpersByProject,
  listHelpers,
  runHelperCommand,
  updateHelper,
} = await import("../src/project-helpers.js");

try {
  const p1 = createProject({ name: "P1", cwd: dir, description: null });
  const p2 = createProject({ name: "P2", cwd: dir, description: null });

  // 1. Initially empty
  assert.deepEqual(listHelpers(p1.id), []);

  // 2. Add
  const h1 = addHelper(p1.id, { name: "Restart server", command: "echo restarted" });
  assert.equal(h1.name, "Restart server");
  assert.equal(h1.command, "echo restarted");
  assert.equal(h1.projectId, p1.id);

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

  // 4. Update
  const updated = updateHelper(p1.id, h1.id, { name: "Restart backend", command: "echo ok" });
  assert.equal(updated?.name, "Restart backend");
  assert.equal(updated?.command, "echo ok");
  assert.equal(getHelper(p1.id, h1.id)?.name, "Restart backend");

  // 5. Run shell execution (success)
  const res1 = await runHelperCommand(dir, "echo 'hello from helper'");
  assert.equal(res1.ok, true);
  assert.equal(res1.exitCode, 0);
  assert.equal(res1.timedOut, false);
  assert.equal(res1.output.trim(), "hello from helper");

  // 6. Run shell execution (failure)
  const res2 = await runHelperCommand(dir, "sh -c 'echo err >&2; exit 42'");
  assert.equal(res2.ok, false);
  assert.equal(res2.exitCode, 42);
  assert.match(res2.output, /err/);

  // 7. Delete
  assert.equal(deleteHelper(p1.id, h1.id), true);
  assert.equal(listHelpers(p1.id).length, 1);
  assert.equal(getHelper(p1.id, h1.id), undefined);

  console.log("project-helpers: 7 passed, 0 failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

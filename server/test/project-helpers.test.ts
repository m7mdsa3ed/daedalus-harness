import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "daedalus-test-helpers-"));
process.env.DAEDALUS_DATA_DIR = dir;

const { createProject, getProject, listProjects, reorderProjects, setProjectDefaults } =
  await import("../src/projects.js");
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
const { UI_GROUP_IDS } = await import("../src/personas.js");
const { listProjectScripts } = await import("../src/project-scripts.js");
const { listShellHistory, recordShellRun } = await import("../src/shell-history.js");

try {
  mkdirSync(join(dir, "sub"));
  const p1 = await createProject({ name: "P1", cwd: dir, description: null });
  const p2 = await createProject({ name: "P2", cwd: dir, description: null });

  // 1. Initially empty
  assert.deepEqual((await listHelpers(p1.id)), []);

  // 2. Add
  const h1 = await addHelper(p1.id, { name: "Restart server", command: "echo restarted" });
  assert.equal(h1.name, "Restart server");
  assert.equal(h1.command, "echo restarted");
  assert.equal(h1.projectId, p1.id);
  // Fields the input left out come back as their empty shapes, not undefined.
  assert.equal(h1.cwd, null);
  assert.equal(h1.env, null);
  assert.equal(h1.description, null);
  assert.equal(h1.confirm, false);

  // Every optional field round-trips, and an add+delete leaves counts alone.
  const h1b = await addHelper(p1.id, {
    name: "Risk",
    command: "echo risky",
    cwd: "sub",
    env: { K: "v", "empty-key": "" },
    description: "The risky one",
    confirm: true,
  });
  const stored = await getHelper(p1.id, h1b.id);
  assert.equal(stored?.cwd, "sub");
  assert.deepEqual(stored?.env, { K: "v", "empty-key": "" });
  assert.equal(stored?.description, "The risky one");
  assert.equal(stored?.confirm, true);
  assert.equal((await deleteHelper(p1.id, h1b.id)), true);

  const h2 = await addHelper(p1.id, { name: "Migrate", command: "echo migrated" });
  const forP1 = await listHelpers(p1.id);
  assert.equal(forP1.length, 2);
  const names = (await forP1).map((h) => h.name).sort();
  assert.deepEqual(names, ["Migrate", "Restart server"]);

  // 3. Project isolation
  assert.deepEqual((await listHelpers(p2.id)), []);
  const byProject = helpersByProject([p1.id, p2.id]);
  assert.equal((await byProject).get(p1.id)?.length, 2);
  assert.equal((await byProject).get(p2.id), undefined);

  // 4. Update — options set, then cleared when the input leaves them out
  const updated = await updateHelper(p1.id, h1.id, {
    name: "Restart backend",
    command: "echo ok",
    cwd: "sub",
    description: "Restarts",
    confirm: true,
  });
  assert.equal(updated?.name, "Restart backend");
  assert.equal(updated?.cwd, "sub");
  assert.equal(updated?.confirm, true);
  assert.equal((await getHelper(p1.id, h1.id))?.name, "Restart backend");

  const cleared = await updateHelper(p1.id, h1.id, { name: "Restart backend", command: "echo ok" });
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
  await db.update(helpersTable).set({ env: "not json" }).where(eq(helpersTable.id, h1.id));
  assert.equal((await getHelper(p1.id, h1.id))?.env, null);
  await db.update(helpersTable).set({ env: null }).where(eq(helpersTable.id, h1.id));

  // 8. Delete
  assert.equal(await deleteHelper(p1.id, h1.id), true);
  assert.equal((await listHelpers(p1.id)).length, 1);
  assert.equal(await getHelper(p1.id, h1.id), undefined);

  /* 9. package.json scripts (root + one directory deep): read off the disk,
        never stored — the `!` completer's second suggestion list. */
  const manifest = (dir === "/" ? dir : `${dir}/`) + "package.json";
  mkdirSync(join(dir, "app"));
  mkdirSync(join(dir, "node_modules/dep"), { recursive: true });
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  writeFileSync(
    manifest,
    JSON.stringify({ scripts: { build: "tsc -b", "test:e2e": "playwright test" } }),
  );
  writeFileSync(
    join(dir, "app/package.json"),
    JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { dev: "vite" } }),
  );
  writeFileSync(
    join(dir, "node_modules/dep/package.json"),
    JSON.stringify({ scripts: { install: "node-gyp rebuild" } }),
  );
  const scripts = await listProjectScripts(p1.id);
  assert.deepEqual(
    scripts.map((s) => [s.name, s.command]),
    [
      // Root: pnpm — the lockfile below says so. Nested: dir-qualified, its
      // own `cd`, and the runner `packageManager` names.
      ["build", "pnpm run build"],
      ["test:e2e", "pnpm run test:e2e"],
      ["app:dev", "cd app && pnpm run dev"],
    ],
  );
  // The other project shares this cwd, so it suggests the same lines — the
  // directory is what's read, never the project's own rows.
  assert.deepEqual(await listProjectScripts(p2.id), scripts);

  // 10. Every distinct shell line and its full contents are retained.
  for (let i = 0; i < 55; i++) await recordShellRun(p1.id, `custom-${i}`);
  const longCommand = `echo ${"x".repeat(2_100)}`;
  await recordShellRun(p1.id, longCommand);
  await recordShellRun(p1.id, "custom-0");
  const shellHistory = await listShellHistory(p1.id);
  assert.equal(shellHistory.length, 56);
  assert.equal(shellHistory.find((use) => use.line === longCommand)?.line, longCommand);
  assert.equal(shellHistory.find((use) => use.line === "custom-0")?.count, 2);
  assert.deepEqual(await listShellHistory(p2.id), []);

  // 11. Order: creation order to start with, then whatever the user drags it
  // to — and a caller naming only some of the ids leaves the rest behind them.
  const p3 = await createProject({ name: "P3", cwd: dir, description: null });
  const named = async () => (await listProjects()).map((p) => p.name);
  assert.deepEqual(await named(), ["P1", "P2", "P3"]);
  await reorderProjects([p3.id, p1.id, p2.id]);
  assert.deepEqual(await named(), ["P3", "P1", "P2"]);
  await reorderProjects([p2.id]);
  assert.deepEqual(await named(), ["P2", "P3", "P1"]);

  // 11. Start defaults: a fresh project is all-empty, a patch moves only what
  // it names, and the columns come back folded into one `defaults` object.
  const fresh = (await getProject(p1.id))!;
  assert.deepEqual(fresh.defaults, {
    profileId: "",
    agentId: "",
    model: "",
    effort: "",
    modeId: "",
    configChoices: {},
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
    suggestKinds: ["prompts", "commands"],
    uiGroups: [...UI_GROUP_IDS],
    personaId: "",
    classifyPersona: true,
    voiceProvider: "",
    askProfiles: {},
  });
  assert.equal("defaultProfileId" in fresh, false, "the wire folds the columns, not raw");

  await setProjectDefaults(p1.id, { profileId: "prof-1", agentId: "agent-1", model: "m-1" });
  const picked = (await getProject(p1.id))!;
  assert.equal(picked.defaults?.profileId, "prof-1");
  assert.equal(picked.defaults?.model, "m-1");
  // Untouched fields are the empty ones, not whatever the patch's neighbours
  // happened to hold — and the sibling project is untouched entirely.
  assert.equal(picked.defaults?.effort, "");
  assert.equal((await getProject(p2.id))!.defaults?.profileId, "");

  // A second patch moves one field and leaves the rest where they are.
  await setProjectDefaults(p1.id, { effort: "high", uiGroups: [] });
  const again = (await getProject(p1.id))!;
  assert.equal(again.defaults?.effort, "high");
  assert.deepEqual(again.defaults?.uiGroups, []);
  assert.equal(again.defaults?.profileId, "prof-1", "an unnamed field keeps its value");
  assert.equal(again.defaults?.model, "m-1");

  // An empty string is the empty pick, stored as null in the column.
  await setProjectDefaults(p1.id, { profileId: "", model: "" });
  const blanked = (await getProject(p1.id))!;
  assert.equal(blanked.defaults?.profileId, "");
  assert.equal(blanked.defaults?.model, "");
  assert.equal(blanked.defaults?.effort, "high", "clearing one field does not clear another");

  // And an unknown project is a miss, not a silent no-op row.
  assert.equal(await setProjectDefaults("nope", { model: "x" }), undefined);

  console.log("project-helpers: 12 passed, 0 failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// The built-in personas: seed 3 offers the roles and retires the first set,
// leaving the user's own rows and edits alone. Run: pnpm test:persona-seeds
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, personas as personasTable, projects as projectsTable } from "../src/db/index.js";
import { RETIRED_PERSONAS, SEED_PERSONAS, seedPersonas } from "../src/persona-seeds.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const ids = async () => new Set((await db.select({ id: personasTable.id }).from(personasTable)).map((r) => r.id));
const roleIds = SEED_PERSONAS.map((p) => p.id);

async function reset(rows: { id: string; name: string; prompt: string; seededVersion: number; description?: string }[]) {
  await db.delete(personasTable);
  for (const row of rows) await db.insert(personasTable).values({ description: "", sortOrder: 0, ...row });
}

await test("a fresh install gets every role and nothing else", async () => {
  await reset([]);
  const r = await seedPersonas();
  assert.equal(r.added, roleIds.length);
  assert.equal(r.retired, 0);
  assert.deepEqual([...(await ids())].sort(), [...roleIds].sort());
});

await test("every role has a description the classifier can read, and roles are distinct", async () => {
  for (const p of SEED_PERSONAS) {
    assert.ok(p.description.length > 20, `${p.id} description`);
    assert.ok(p.prompt.length > 100, `${p.id} prompt`);
  }
  assert.equal(new Set(roleIds).size, roleIds.length);
  for (const target of Object.values(RETIRED_PERSONAS)) if (target) assert.ok(roleIds.includes(target), `${target} exists`);
});

await test("seed 3 retires the first set, repoints a project, and keeps the user's rows and App builder", async () => {
  await reset([
    { id: "builtin:review", name: "Review", prompt: "old", seededVersion: 1 },
    { id: "builtin:think-more", name: "Think more", prompt: "old", seededVersion: 1 },
    { id: "builtin:app-builder", name: "App builder", prompt: "build", seededVersion: 2 },
    { id: "11111111-1111-1111-1111-111111111111", name: "Echo", prompt: "YES", seededVersion: 0 },
  ]);
  await db.delete(projectsTable);
  await db.insert(projectsTable).values({ id: "p-review", name: "a", cwd: "/tmp/a", defaultPersonaId: "builtin:review" });
  await db.insert(projectsTable).values({ id: "p-think", name: "b", cwd: "/tmp/b", defaultPersonaId: "builtin:think-more" });
  const r = await seedPersonas();
  assert.equal(r.retired, 2);
  assert.equal(r.added, roleIds.length);
  const have = await ids();
  assert.ok(!have.has("builtin:review") && !have.has("builtin:think-more"), "first set gone");
  assert.ok(have.has("builtin:app-builder") && have.has("11111111-1111-1111-1111-111111111111"), "kept");
  const projects = Object.fromEntries((await db.select({ id: projectsTable.id, p: projectsTable.defaultPersonaId }).from(projectsTable)).map((r) => [r.id, r.p]));
  assert.equal(projects["p-review"], "builtin:reviewer");
  assert.equal(projects["p-think"], null);
  await db.delete(projectsTable);
});

await test("a second boot changes nothing, a deleted role stays deleted, an edit is kept", async () => {
  await reset([]);
  await seedPersonas();
  await db.delete(personasTable).where(eq(personasTable.id, "builtin:writer"));
  await db.update(personasTable).set({ prompt: "mine", name: "My debugger" }).where(eq(personasTable.id, "builtin:debugger"));
  const r = await seedPersonas();
  assert.deepEqual(r, { added: 0, retired: 0 });
  const have = await ids();
  assert.ok(!have.has("builtin:writer"), "deleted on purpose stays deleted");
  const dbg = (await db.select().from(personasTable).where(eq(personasTable.id, "builtin:debugger")))[0]!;
  assert.equal(dbg.prompt, "mine");
  assert.equal(dbg.name, "My debugger");
});

await test("a first-set row the user re-made by hand (seeded_version 0) is not retired", async () => {
  await reset([{ id: "builtin:lazy", name: "Lazy", prompt: "my own", seededVersion: 0 }]);
  const r = await seedPersonas();
  assert.equal(r.retired, 0);
  assert.ok((await ids()).has("builtin:lazy"));
});

await db.delete(personasTable);
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n\n  ${failures.join("\n\n  ")}`);
  process.exit(1);
}
console.log(`persona-seeds: ${passed} passed`);
process.exit(0);

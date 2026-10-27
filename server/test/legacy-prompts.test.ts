// Saved prompts migrate into slash commands once; personas are left alone.
// Run: pnpm test:legacy-prompts
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { appSettings, commands, db, personas, savedPrompts } from "../src/db/index.js";
import { migrateLegacyPrompts } from "../src/legacy-prompts.js";

await db.delete(commands);
await db.delete(appSettings);
await db.delete(personas);
await db.delete(savedPrompts);
await db.insert(commands).values({ id: "own", name: "review", description: "mine", content: "MINE" });
await db.insert(savedPrompts).values([
  { id: "builtin:review", name: "review", description: "", prompt: "REVIEW", seededVersion: 1, sortOrder: 1 },
  { id: "u1", name: "fix", title: "Fix", description: "Quick", prompt: "FIX" },
]);
await db.insert(personas).values({ id: "p1", name: "Think more!", prompt: "THINK" });
await migrateLegacyPrompts();

const rows = Object.fromEntries((await db.select().from(commands)).map((r) => [r.id, r]));
assert.equal(rows.own.content, "MINE", "a user's own command is untouched");
assert.equal(rows["builtin:review"].name, "review-2", "a name another command holds is suffixed");
assert.equal(rows["builtin:review"].description, "review", "an empty description falls back to the name");
assert.deepEqual([rows.u1.name, rows.u1.description, rows.u1.content], ["fix", "Quick", "FIX"]);
assert.equal(rows.p1, undefined, "a persona is not copied into commands");
assert.equal((await db.select().from(personas)).length, 1, "and stays a persona");

await db.delete(commands);
await migrateLegacyPrompts();
assert.equal((await db.select().from(commands)).length, 0, "the marker stops a second run");
console.log("legacy-prompts: all assertions passed");

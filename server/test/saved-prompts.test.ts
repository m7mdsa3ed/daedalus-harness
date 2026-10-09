// Saved prompts: `@name` expands in the text the agent receives, handles are
// validated, and legacy personas migrate once.
// Run: pnpm test:saved-prompts
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { db, appSettings, personas, savedPrompts as table } from "../src/db/index.js";
import { PromptInputSchema, expandPrompts, migrateLegacyPersonas, savedPrompts, seedPrompts } from "../src/saved-prompts.js";

await db.delete(table);
await savedPrompts.create({ name: "fix", title: "", description: "", prompt: "FIXTEXT", sortOrder: 0 });

const ex = async (t: string) => (await expandPrompts(t)).text;
assert.equal(await ex("please @fix this"), "please FIXTEXT this", "a known handle expands");
assert.equal(await ex("@fix. now"), "FIXTEXT. now", "trailing punctuation stays after the prompt");
assert.equal(await ex("see @nope"), "see @nope", "an unknown token is untouched");
assert.equal(await ex("mail a@fix.com"), "mail a@fix.com", "an email-like token is untouched");
assert.equal(await ex("@Fix"), "@Fix", "case-sensitive");
assert.deepEqual([...(await expandPrompts("@fix and @fix")).names], ["fix"]);

assert.ok(PromptInputSchema.safeParse({ name: "ok_name-2", prompt: "x" }).success);
for (const bad of ["", "Upper", "has space", "-lead", "@at"])
  assert.ok(!PromptInputSchema.safeParse({ name: bad, prompt: "x" }).success, `rejects ${JSON.stringify(bad)}`);
await assert.rejects(savedPrompts.create({ name: "fix", title: "", description: "", prompt: "y", sortOrder: 0 }), /already exists/);

// Migration: copies once, slugs and dedupes, and a built-in it copied is not re-seeded.
await db.delete(table);
await db.delete(appSettings);
await db.delete(personas);
await db.insert(personas).values([
  { id: "builtin:think-more", name: "Think more", prompt: "P", thinking: 1, effort: "high", seededVersion: 2, sortOrder: 1 },
  { id: "u1", name: "Think more", prompt: "Q" },
]);
await migrateLegacyPersonas();
await seedPrompts();
const rows = await db.select().from(table);
assert.deepEqual(rows.map((r) => r.name).sort(), ["think-more", "think-more-2"]);
await savedPrompts.remove("u1");
await migrateLegacyPersonas();
await seedPrompts();
assert.deepEqual((await db.select().from(table)).map((r) => r.id), ["builtin:think-more"], "a deleted row stays deleted");
console.log("saved-prompts: all assertions passed");

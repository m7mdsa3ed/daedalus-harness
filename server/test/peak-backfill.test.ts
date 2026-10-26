// The boot backfill that stamps the published rate cards onto models a profile
// already holds (`peak-schedules.ts`).
//
// The failure this guards is quiet in the worst way: a schedule stamped onto a
// model that does not bill by the clock is a badge inventing a surcharge, and a
// schedule stamped over one the user wrote erases their correction. Both are
// checked here against a real profile row.
//
// Run: pnpm test:peak-backfill
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { db, profiles as profilesTable } from "../src/db/index.js";
import { backfillPeakSchedules, knownPeakFor } from "../src/peak-schedules.js";

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

await db.delete(profilesTable);

const profile = async (id: string, models: unknown[]) => {
  await db.insert(profilesTable).values({
    id,
    name: id,
    agents: { daedalus: {} },
    baseUrl: "https://gw.example/v1",
    apiKey: "",
    models: models as never,
    defaultModel: (models[0] as { id: string }).id,
    smallModel: "",
    logoUrl: "",
    usage: null,
    suppressModelMetadataWarning: false,
    hidden: false,
    disabled: false,
  });
};

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  reasoningEfforts: [],
  pricing: { input: 1, output: 2 },
  ...extra,
});

await test("stamps the two families that bill by the clock", async () => {
  await profile("gw", [
    model("cmd/deepseek/deepseek-v4.1-flash"),
    model("cmd/z-ai/glm-5.3-flash"),
    model("cc/claude-sonnet-5-5"),
    model("cmc/gpt-6-luna"),
  ]);
  const stamped = await backfillPeakSchedules();
  assert.equal(stamped, 2, "only DeepSeek and GLM");
  const row = (await db.select().from(profilesTable))[0]!;
  const byId = Object.fromEntries(row.models.map((m) => [m.id, m]));
  assert.equal(byId["cmd/deepseek/deepseek-v4.1-flash"]?.peak?.windows, "Mon-Fri 01:00-04:00, 06:00-10:00 UTC");
  assert.equal(byId["cmd/z-ai/glm-5.3-flash"]?.peak?.windows, "Mon-Fri 14:00-18:00 Asia/Singapore");
  assert.equal(byId["cc/claude-sonnet-5-5"]?.peak, undefined, "Anthropic has no time-of-day card");
  assert.equal(byId["cmc/gpt-6-luna"]?.peak, undefined, "OpenAI varies by tier, not by hour");
});

await test("a schedule the user wrote is theirs", async () => {
  const mine = { windows: "Mon-Fri 09:00-17:00 Europe/Berlin", when: "peak" as const, multiplier: 3 };
  await db.delete(profilesTable);
  await profile("gw", [model("deepseek-v4-pro", { peak: mine })]);
  await backfillPeakSchedules();
  const row = (await db.select().from(profilesTable))[0]!;
  assert.deepEqual(row.models[0]?.peak, mine, "never overwritten");
});

await test("a model with no listed price is left alone", async () => {
  await db.delete(profilesTable);
  await profile("gw", [{ id: "oc/deepseek-v4.1-flash-free", label: "f", reasoningEfforts: [] }]);
  assert.equal(await backfillPeakSchedules(), 0);
  const row = (await db.select().from(profilesTable))[0]!;
  assert.equal(row.models[0]?.peak, undefined);
});

await test("it runs once", async () => {
  // The marker row is written by the first call; a second boot must not redo it.
  assert.equal(await backfillPeakSchedules(), 0);
});

await test("the matcher reads the leaf, never the whole path", async () => {
  assert.ok(knownPeakFor("cmd/deepseek/deepseek-v4.1-flash"));
  assert.ok(knownPeakFor("deepseek-v4-pro"));
  assert.equal(knownPeakFor("oc/jev-1.13-free"), null);
});

if (failures.length) {
  console.error(`peak-backfill: ${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`peak-backfill: ok (${passed} passed)`);

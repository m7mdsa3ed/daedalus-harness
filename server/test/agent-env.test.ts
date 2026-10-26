// Self-check for Settings' environment editor (`client/src/components/settings/
// agent-env.tsx`), whose classification decides which keys a person is offered
// to edit and which are shown as the profile's wiring.
//
// The one property worth holding: **saving never changes a key it did not mean
// to change**. Everything else — which bucket a key lands in — is a reading, and
// a wrong reading is a wrong label, recoverable. A merge that dropped a seeded
// template because nobody edited it would break the spawn, and the form would
// say "saved".
// Run: pnpm test:agent-env
import assert from "node:assert/strict";
import { splitEnv, mergeEnv } from "../../client/src/lib/agent-env.js";
import { ENV_KEY, duplicateNames, recordFromRows, rowsFromRecord } from "../../client/src/lib/key-value-rows.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/* The shapes the seeds actually ship: a placeholder-driven key, a JSON object, a
   literal, and a key the person overwrote. */
const SEEDED = {
  ANTHROPIC_API_KEY: "{apiKey}",
  ANTHROPIC_BASE_URL: "{gatewayUrl}",
  DAEDALUS_AGENT_PROJECT_INSTRUCTIONS: "1",
};
const CONFIG_KEY = "CODEX_CONFIG";
const config = '{"permission":"allow","model":"{model}"}';

test("a seeded key still holding its placeholder is the profile's, not a person's", () => {
  const split = splitEnv({ ...SEEDED }, SEEDED);
  assert.deepEqual(split.driven.map((d) => d.name), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  assert.deepEqual(split.mine.map((r) => r.name), ["DAEDALUS_AGENT_PROJECT_INSTRUCTIONS"]);
  assert.equal(split.advanced.length, 0, "a literal is not a JSON template");
});

test("a seeded key the person overwrote is theirs", () => {
  const split = splitEnv({ ...SEEDED, ANTHROPIC_BASE_URL: "https://mine.example/v1" }, SEEDED);
  assert.deepEqual(split.driven.map((d) => d.name), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(split.mine.map((r) => r.name).sort(), ["ANTHROPIC_BASE_URL", "DAEDALUS_AGENT_PROJECT_INSTRUCTIONS"]);
});

test("a whole config object is text, whatever its placeholders", () => {
  const split = splitEnv({ ...SEEDED, [CONFIG_KEY]: config }, SEEDED);
  assert.deepEqual(split.advanced.map((a) => a.name), [CONFIG_KEY]);
  assert.equal(split.mine.some((r) => r.name === CONFIG_KEY), false, "a config is never a one-line row");
});

test("saving an untouched form changes nothing — every key comes back byte for byte", () => {
  const env = { ...SEEDED, [CONFIG_KEY]: config, MY_FLAG: "1" };
  const split = splitEnv(env, SEEDED);
  assert.deepEqual(mergeEnv(split, split.mine), env);
});

test("an edited row is saved, and an emptied one disappears", () => {
  const env = { MY_FLAG: "1", OTHER: "2" };
  const split = splitEnv(env, {});
  const rows = split.mine.map((r) => (r.name === "MY_FLAG" ? { ...r, value: "0" } : { ...r, name: "" }));
  assert.deepEqual(mergeEnv(split, rows), { MY_FLAG: "0" }, "a blank name is a row somebody abandoned");
});

test("a config edited as text keeps its placeholders and goes back whole", () => {
  const env = { ...SEEDED, [CONFIG_KEY]: config };
  const split = splitEnv(env, SEEDED);
  const text = '{"permission":"ask","model":"{model}"}';
  const merged = { ...mergeEnv(split, split.mine), [CONFIG_KEY]: text };
  assert.equal(merged[CONFIG_KEY], text);
  assert.equal(merged.ANTHROPIC_API_KEY, "{apiKey}", "the wiring is still there");
});

test("a bad variable name is caught here, not dropped at spawn", () => {
  assert.equal(ENV_KEY.test("MY_FLAG"), true);
  assert.equal(ENV_KEY.test("_private"), true);
  assert.equal(ENV_KEY.test("A1"), true);
  assert.equal(ENV_KEY.test("MY FLAG"), false);
  assert.equal(ENV_KEY.test("1ABC"), false);
  assert.equal(ENV_KEY.test("MY-FLAG"), false);
  assert.equal(ENV_KEY.test(""), false);
});

test("two rows with one name are reported, not silently collapsed", () => {
  const rows = [
    { id: "a", name: "TOKEN", value: "1" },
    { id: "b", name: "token", value: "2" },
    { id: "c", name: "OTHER", value: "3" },
  ];
  /* Reported case-insensitively — `TOKEN` and `token` in one box is a mistake
     worth naming — even though the two are distinct keys to a process. */
  assert.equal(duplicateNames(rows, { caseInsensitive: true }).size, 1);
  assert.equal(duplicateNames(rows).size, 0, "exact match is the strict reading");
  /* Last one wins, and it is what a process would see. */
  const same = [
    { id: "a", name: "TOKEN", value: "1" },
    { id: "b", name: "TOKEN", value: "2" },
  ];
  assert.equal(recordFromRows(same).TOKEN, "2");
});

test("a record round-trips through rows in order", () => {
  const record = { A: "1", B: "2", C: "3" };
  assert.deepEqual(recordFromRows(rowsFromRecord(record)), record);
  assert.deepEqual(rowsFromRecord(undefined), []);
});

console.log(`agent-env: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);

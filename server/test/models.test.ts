// Self-check for the profile models pipeline: the models.dev proxy (normalizing
// a fetch into ModelDevEntry and searching it), the provider's own /models
// endpoint (dialects, base-URL spellings, fallbacks), and the mapping of the
// two — fetched ids enriched with exact-match models.dev metadata.
//
// The models.dev catalog is cached in memory for an hour, so the fetch stub is
// installed before the first call and every test shares one fixture. Provider
// endpoints are canned per URL; anything else reaching fetch is a test bug.
// Run: pnpm test:models
import assert from "node:assert/strict";

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

/* One small stand-in for models.dev's api.json. "smart-2" lives under two
   providers to prove the ranking; efforts arrive mixed-case to prove the
   normalization; the "toggle" reasoning option must be ignored. */
const FIXTURE = {
  provA: {
    id: "provA",
    name: "Provider A",
    models: {
      "smart-2": {
        id: "smart-2",
        name: "Smart 2",
        description: "The smart one",
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["Low", "HIGH"] }, { type: "toggle" }],
      },
      "smart-2-pro": { id: "smart-2-pro", name: "Smart 2 Pro" },
      "clever-1": { id: "clever-1", name: "Clever One" },
    },
  },
  provB: {
    id: "provB",
    name: "Provider B",
    models: { "smart-2": { id: "smart-2", name: "B's Smart 2" } },
  },
  /* The community file's real shapes, which the reader must survive rather than
     trust. models.dev ships `values: [null, "low", …]` for "no effort" on the
     sarvam models, and one `.trim()` on that null failed the whole catalog —
     every provider, every search, 502 as "couldn't reach models.dev". */
  provC: {
    id: "provC",
    name: "Provider C",
    models: {
      "ragged-1": {
        id: "ragged-1",
        name: null,
        description: 7,
        limit: { context: "200000", output: 0 },
        modalities: { input: ["text", null] },
        reasoning_options: [null, { type: "effort", values: [null, "Low", "low"] }],
      },
      // Free is a price, not a missing one: it is why a profile points at a gateway.
      "free-1": { id: "free-1", name: "Free One", cost: { input: 0, output: 0 } },
      "gone-1": null,
    },
  },
};

/** Provider endpoints, canned per URL. Anything unknown reaching fetch here
    means a candidate-URL change the tests have not been told about. */
const canned = new Map<string, { status: number; body?: unknown }>();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  if (url.includes("models.dev")) return new Response(JSON.stringify(FIXTURE), { status: 200 });
  const hit = canned.get(url);
  if (!hit) throw new Error(`unexpected fetch in test: ${url}`);
  return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), { status: hit.status });
}) as typeof fetch;

const { searchModelsDev, modelsDevProviders, toCandidate } = await import("../src/models-dev.js");
const {
  parseProviderModels,
  fetchProviderModels,
  enrichProviderModels,
} = await import("../src/provider-models.js");

// --- the models.dev proxy ---

await test("searchModelsDev ranks exact id first and normalizes entries", async () => {
  const hits = await searchModelsDev("smart-2");
  assert.deepEqual(
    hits.map((h) => `${h.providerId}/${h.id}`),
    // Both providers carry an exact "smart-2" (sorted by provider id), then the prefix hit.
    ["provA/smart-2", "provB/smart-2", "provA/smart-2-pro"],
  );
  const top = hits[0];
  assert.equal(top.name, "Smart 2");
  assert.equal(top.description, "The smart one");
  assert.equal(top.contextWindow, 200000);
  assert.equal(top.maxOutputTokens, 64000);
  assert.deepEqual(top.pricing, { input: 3, output: 15 });
  // Mixed-case efforts lowered; the "toggle" reasoning option ignored.
  assert.deepEqual(top.reasoningEfforts, ["low", "high"]);
  assert.deepEqual(top.modalities, ["text", "image"]);
});

await test("searchModelsDev filters by provider and answers an empty query with the provider's list", async () => {
  const hits = await searchModelsDev("", { provider: "provB" });
  assert.deepEqual(
    hits.map((h) => `${h.providerId}/${h.id}`),
    ["provB/smart-2"],
  );
  const capped = await searchModelsDev("", { provider: "provA", limit: 2 });
  assert.equal(capped.length, 2);
});

await test("searchModelsDev matches names too, and misses stay misses", async () => {
  const byName = await searchModelsDev("clever", { limit: 1 });
  assert.equal(byName[0]?.id, "clever-1");
  assert.deepEqual(await searchModelsDev("no-such-model-anywhere"), []);
});

await test("modelsDevProviders lists providers by name", async () => {
  assert.deepEqual(await modelsDevProviders(), [
    { id: "provA", name: "Provider A" },
    { id: "provB", name: "Provider B" },
    { id: "provC", name: "Provider C" },
  ]);
});

await test("a malformed catalog entry costs that entry, never the catalog", async () => {
  // The catalog answered at all: one bad field used to throw out of the
  // normalize loop and take every provider with it.
  const [ragged] = await searchModelsDev("ragged-1");
  assert.equal(ragged.name, "ragged-1", "a null name falls back to the id");
  assert.equal(ragged.description, undefined, "a non-string description is dropped");
  assert.equal(ragged.contextWindow, undefined, "a stringy limit is not a number");
  assert.equal(ragged.maxOutputTokens, undefined, "zero is not a limit");
  assert.deepEqual(ragged.reasoningEfforts, ["low"], "the null effort is skipped, the rest deduped");
  assert.deepEqual(ragged.modalities, ["text"]);
  // A model that is not an object at all is simply absent.
  assert.deepEqual(await searchModelsDev("gone-1"), []);
  const [free] = await searchModelsDev("free-1");
  assert.deepEqual(free.pricing, { input: 0, output: 0 }, "free is a price");
});

await test("toCandidate answers in the client's ModelCandidate shape", async () => {
  const [hit] = await searchModelsDev("smart-2");
  const candidate = toCandidate(hit);
  // `label`, not `name` — the field every client reader looks for — and the
  // provenance already assembled, so an import carries where it came from.
  assert.equal(candidate.label, "Smart 2");
  assert.equal(candidate.devRef, "provA/smart-2");
  assert.equal("name" in candidate, false);
  assert.equal(candidate.contextWindow, 200000);
  assert.deepEqual(candidate.reasoningEfforts, ["low", "high"]);
});

// --- the provider's own /models endpoint ---

await test("parseProviderModels reads every dialect and dedupes ids", () => {
  const openai = parseProviderModels({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] });
  assert.deepEqual(openai.map((m) => m.id), ["a", "b"]);
  // Anthropic's display_name, Ollama's `models` + `name`, and a bare array.
  const anthropic = parseProviderModels({ data: [{ id: "x", display_name: "X Ray" }] });
  assert.deepEqual(anthropic, [{ id: "x", label: "X Ray" }]);
  const ollama = parseProviderModels({ models: [{ name: "llama" }] });
  assert.deepEqual(ollama, [{ id: "llama" }]);
  const bare = parseProviderModels(["one", "two"]);
  assert.deepEqual(bare.map((m) => m.id), ["one", "two"]);
  assert.deepEqual(parseProviderModels({ nothing: true }), []);
});

await test("fetchProviderModels tries /v1/models first for a bare base URL", async () => {
  canned.clear();
  canned.set("https://api.example.com/v1/models", { status: 200, body: { data: [{ id: "m1" }] } });
  const models = await fetchProviderModels("https://api.example.com", "sk-test");
  assert.deepEqual(models.map((m) => m.id), ["m1"]);
});

await test("fetchProviderModels handles a base URL that already ends in /v1", async () => {
  canned.clear();
  canned.set("https://api.example.com/v1/models", { status: 200, body: { data: [{ id: "m1" }] } });
  const models = await fetchProviderModels("https://api.example.com/v1/", "sk-test");
  assert.deepEqual(models.map((m) => m.id), ["m1"]);
});

await test("fetchProviderModels falls back to the other spelling when the first 404s", async () => {
  canned.clear();
  canned.set("https://api.example.com/v1/models", { status: 404 });
  canned.set("https://api.example.com/models", { status: 200, body: { models: [{ name: "m2" }] } });
  const models = await fetchProviderModels("https://api.example.com", "sk-test");
  assert.deepEqual(models.map((m) => m.id), ["m2"]);
});

await test("fetchProviderModels throws with every attempt when nothing answers", async () => {
  canned.clear();
  canned.set("https://api.example.com/v1/models", { status: 401 });
  canned.set("https://api.example.com/models", { status: 500 });
  await assert.rejects(
    fetchProviderModels("https://api.example.com", "bad-key"),
    (err: Error) => err.message.includes("401") && err.message.includes("500"),
  );
});

// --- the mapping: fetched ids x models.dev ---

await test("enrichProviderModels fills metadata on exact match and leaves the rest bare", async () => {
  const [matched, unknown, prefixed] = await enrichProviderModels([
    { id: "smart-2" },
    { id: "unknown-gw" },
    { id: "vendor/smart-2" },
  ]);
  // Exact match: the whole catalog entry arrives.
  assert.equal(matched.label, "Smart 2");
  assert.equal(matched.description, "The smart one");
  assert.deepEqual(matched.pricing, { input: 3, output: 15 });
  assert.deepEqual(matched.reasoningEfforts, ["low", "high"]);
  assert.equal(matched.devRef, "provA/smart-2");
  // A gateway id models.dev does not know stays bare — never fuzzy-guessed.
  assert.equal(unknown.description, undefined);
  assert.equal(unknown.devRef, undefined);
  assert.equal(unknown.label, "unknown-gw");
  // The tail after the last "/" is tried too — a prefixed gateway id finds
  // its unprefixed entry.
  assert.equal(prefixed.devRef, "provA/smart-2");
});

await test("enrichProviderModels prefers the endpoint's own display name", async () => {
  const [named] = await enrichProviderModels([{ id: "smart-2", label: "Endpoint's name" }]);
  assert.equal(named.label, "Endpoint's name");
  // models.dev's name is still metadata — but never overwrites the label.
  assert.equal(named.devRef, "provA/smart-2");
});

console.log(`models: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`\nFAIL ${failure}`);
process.exit(failures.length ? 1 : 0);

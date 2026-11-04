// Self-check for the decision lane's call and its choice — `server/src/decide.ts`
// and `server/src/side-models.ts` (docs/plans/persona-decision.md).
//
// A real local HTTP server stands in for a System One endpoint, which is the
// only way to assert the path (a versioned-root rule, not a blind append), the
// bearer, the exact body, and BOTH response envelopes the vendors write.
//
// Run: pnpm test:decide
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { decide, decisionUrl, readDecision } from "../src/decide.js";
import { HttpError } from "../src/http-error.js";
import { appSettings, db, profiles as profilesTable } from "../src/db/index.js";
import { createProfile, deleteProfile } from "../src/profiles.js";
import {
  PERSONA_DECISION_DEFAULTS,
  readPersonaDecision,
  setPersonaDecision,
  setSideDefault,
  sideCandidates,
} from "../src/side-models.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

interface Seen {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({
      url: req.url ?? "",
      authorization: (req.headers.authorization as string) ?? null,
      body: raw ? JSON.parse(raw) : {},
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const questions = { persona: { type: "choice" as const, instructions: "which?", criteria: { a: "A", none: "None" } } };
await db.delete(appSettings);
await db.delete(profilesTable);

const base = (wire: "systemone" | "systemone-gateway" | undefined, baseUrl = origin) => ({
  name: "stub",
  agents: { daedalus: {} },
  baseUrl,
  apiKey: "sk-test",
  defaultModel: "chat",
  smallModel: "",
  suppressModelMetadataWarning: false,
  hidden: false,
  disabled: false,
  logoUrl: "",
  models: [
    { id: "jev", label: "Jev", reasoningEfforts: [], kind: "decision" as const, ...(wire ? { wire } : {}) },
    { id: "chat", label: "Chat", reasoningEfforts: [] },
  ],
});

await test("decisionUrl: a versioned root takes the tail alone, any other gets the version", () => {
  assert.equal(decisionUrl("https://api.typesafe.ai", "systemone"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(decisionUrl("https://api.typesafe.ai/", "systemone"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(decisionUrl("http://localhost:20128/v1", "systemone"), "http://localhost:20128/v1/systemone");
  assert.equal(decisionUrl("http://localhost:20128/v1/", "systemone-gateway"), "http://localhost:20128/v1/decisions");
});

await test("readDecision: the hosted envelope and the gateway's `answers` envelope", () => {
  const hosted = readDecision(
    { persona: { type: "choice", choice: { a: 0.8, none: 0.2 }, confidence: 0.8 }, model: "jev-1.13.0" },
    ["persona"],
    "jev",
  );
  assert.deepEqual(hosted.answers.persona, { choice: { a: 0.8, none: 0.2 }, confidence: 0.8 });
  assert.equal(hosted.model, "jev-1.13.0");
  const gateway = readDecision({ answers: { persona: { choice: { a: 0.7, none: 0.3 } } }, model: "jev-1.13-free" }, ["persona"], "oc/jev-1.13-free");
  assert.deepEqual(gateway.answers.persona, { choice: { a: 0.7, none: 0.3 } });

  // The gateway's real answer: the label in `choice`, the distribution in `probabilities`.
  const live = readDecision(
    { model: "jev-1.13-free", answers: { persona: { type: "choice", choice: "a", confidence: 0.98, probabilities: { none: 0.01, a: 0.99 } } } },
    ["persona"],
    "oc/jev-1.13-free",
  );
  assert.deepEqual(live.answers.persona, { choice: { none: 0.01, a: 0.99 }, confidence: 0.98 });
  assert.equal(gateway.model, "jev-1.13-free", "reports what answered, not what was asked");
  assert.equal(readDecision({ answers: { x: { noul: 0.81 } } }, ["x"], "m").answers.x?.probability, 0.81);
  assert.equal(readDecision({ persona: { choice: { a: 1 } } }, ["persona"], "asked").model, "asked", "no model in the body");
});

await test("readDecision: unreadable is a 502, not a pick", () => {
  for (const body of [null, "x", [], {}, { answers: {} }, { persona: { choice: {} } }, { persona: "a" }]) {
    assert.throws(() => readDecision(body, ["persona"], "m"), (e) => e instanceof HttpError && e.status === 502);
  }
});

await test("decide: posts the body to the wire's path with the bearer", async () => {
  const profile = await createProfile(base("systemone"));
  try {
    seen.length = 0;
    reply = { status: 200, body: { persona: { choice: { a: 0.9, none: 0.1 } }, model: "jev-1.13.0" } };
    const got = await decide(profile, { model: "jev", state: "Project: p\n\nhello", questions });
    assert.equal(seen[0]?.url, "/v1/systemone");
    assert.equal(seen[0]?.authorization, "Bearer sk-test");
    assert.deepEqual(seen[0]?.body, { model: "jev", state: "Project: p\n\nhello", questions });
    assert.equal(got.model, "jev-1.13.0");
    assert.deepEqual(got.answers.persona?.choice, { a: 0.9, none: 0.1 });
  } finally {
    await deleteProfile(profile.id);
  }
});

await test("decide: systemone-gateway takes /decisions, and a /v1 base is not doubled", async () => {
  const profile = await createProfile(base("systemone-gateway", `${origin}/v1`));
  try {
    seen.length = 0;
    reply = { status: 200, body: { answers: { persona: { choice: { a: 1 } } } } };
    await decide(profile, { model: "jev", state: "s", questions });
    assert.equal(seen[0]?.url, "/v1/decisions");
  } finally {
    await deleteProfile(profile.id);
  }
});

await test("decide: refusals are configuration answers, a 429 is the provider's", async () => {
  const profile = await createProfile(base("systemone"));
  const noWire = await createProfile(base(undefined));
  try {
    const status = (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof HttpError ? e.status : -1));
    assert.equal(await status(decide(profile, { model: "chat", state: "s", questions })), 400, "chat model");
    assert.equal(await status(decide(noWire, { model: "jev", state: "s", questions })), 400, "no wire");
    assert.equal(await status(decide(profile, { model: "nope", state: "s", questions })), 409, "unknown model");
    assert.equal(await status(decide(profile, { model: "jev", state: "", questions })), 400, "empty state");
    assert.equal(await status(decide(profile, { model: "jev", state: "s", questions: {} })), 400, "no questions");
    seen.length = 0;
    reply = { status: 429, body: "Free usage limit reached" };
    await assert.rejects(
      decide(profile, { model: "jev", state: "s", questions }),
      (e) => e instanceof HttpError && e.status === 502 && e.message.startsWith("429"),
    );
  } finally {
    await deleteProfile(profile.id);
    await deleteProfile(noWire.id);
  }
});

await test("side-models: the decision lane lists and stores both System One wires", async () => {
  const a = await createProfile({ ...base("systemone"), name: "a" });
  const b = await createProfile({ ...base("systemone-gateway"), name: "b" });
  try {
    const candidates = await sideCandidates("decision");
    assert.ok(candidates.some((c) => c.profileId === a.id && c.model === "jev"));
    assert.ok(candidates.some((c) => c.profileId === b.id && c.model === "jev"), "systemone-gateway is a candidate");
    assert.equal((await setSideDefault("decision", { profileId: b.id, model: "jev" })).default?.profileId, b.id);
    await assert.rejects(setSideDefault("decision", { profileId: a.id, model: "chat" }), (e) => e instanceof HttpError && e.status === 400);
    await assert.rejects(setSideDefault("completion", { profileId: a.id, model: "jev" }), (e) => e instanceof HttpError && e.status === 400);
  } finally {
    await setSideDefault("decision", null);
    await deleteProfile(a.id);
    await deleteProfile(b.id);
  }
});

await test("side-models: the persona thresholds default, store, merge and refuse", async () => {
  assert.deepEqual(await readPersonaDecision(), PERSONA_DECISION_DEFAULTS);
  assert.deepEqual(await setPersonaDecision({ margin: 0.3 }), { minProbability: 0.5, margin: 0.3 });
  assert.deepEqual(await readPersonaDecision(), { minProbability: 0.5, margin: 0.3 });
  await assert.rejects(setPersonaDecision({ minProbability: 1.5 }), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(setPersonaDecision({ margin: Number.NaN }), (e) => e instanceof HttpError && e.status === 400);
  assert.equal((await readPersonaDecision()).margin, 0.3, "a refusal stores nothing");
  await setPersonaDecision(PERSONA_DECISION_DEFAULTS);
});

server.close();
if (failures.length) {
  console.error(`decide: ${failures.length} failed, ${passed} passed\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`decide: ${passed} passed`);
process.exit(0);

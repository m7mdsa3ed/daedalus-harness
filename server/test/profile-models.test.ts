// Self-check for "add a model on the fly" (POST /api/profiles/:id/models).
//
// The one thing that can really go wrong here is the credential: the client is
// sent `hasApiKey` and never the key, so appending a model must not be a
// round-trip of the profile through the browser. The route does the append
// server-side and passes `apiKey: ""`, which `updateProfile` reads as "keep the
// stored one" — that bargain is what this asserts, alongside the two rules the
// route states (idempotent on a repeated id, refused for a virtual profile).
//
// Run: pnpm test:profile-models
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { profiles as profilesTable, db, type ModelKind, type ModelWire } from "../src/db/index.js";
import { profileRoutes } from "../src/routes/profiles.js";
import {
  ProfileInputSchema,
  createProfile,
  duplicateProfile,
  exportProfile,
  getProfile,
  redact,
  syncProfile,
  updateProfile,
} from "../src/profiles.js";

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

/** Exactly what the route does, minus Hono. Kept in step with
    `routes/profiles.ts` — if that append grows a rule, this grows it too. */
async function addModel(
  profileId: string,
  model: { id: string; label: string; kind?: ModelKind; wire?: ModelWire },
) {
  const profile = await getProfile(profileId);
  if (!profile) return { error: "unknown profile" as const };
  if (profile.virtual) return { error: "virtual" as const };
  if (profile.models.some((m) => m.id === model.id)) return { profile };
  const updated = await updateProfile(profile.id, {
    ...profile,
    apiKey: "",
    smallModel: profile.smallModel ?? "",
    suppressModelMetadataWarning: profile.suppressModelMetadataWarning ?? false,
    hidden: profile.hidden ?? false,
    disabled: profile.disabled ?? false,
    models: [...profile.models, { ...model, reasoningEfforts: [] }],
  });
  return { profile: updated };
}

await db.delete(profilesTable);

const seeded = await createProfile({
  name: "gateway",
  agents: { "claude-code": {} },
  baseUrl: "https://gw.example/v1",
  apiKey: "sk-secret",
  models: [{ id: "smart-1", label: "Smart 1", reasoningEfforts: ["low"] }],
  defaultModel: "smart-1",
  smallModel: "",
  usage: { kind: "zai", baseUrl: "", apiKey: "sk-usage" },
  suppressModelMetadataWarning: false,
  hidden: false,
  disabled: false,
  logoUrl: "",
});

await test("appends the model and keeps the stored key", async () => {
  const { profile } = await addModel(seeded.id, { id: "smart-2", label: "Smart 2" });
  assert.deepEqual(
    profile?.models.map((m) => m.id),
    ["smart-1", "smart-2"],
    "the new model is appended, never replacing the catalog",
  );
  assert.equal(profile?.apiKey, "sk-secret", "a blank apiKey means keep the stored one");
  assert.equal(profile?.usage?.apiKey, "sk-usage", "…and the usage key rides the same rule");
  assert.equal(profile?.defaultModel, "smart-1", "adding a model does not move the default");
  assert.deepEqual(
    profile?.models[0]?.reasoningEfforts,
    ["low"],
    "the models already listed come back untouched",
  );
});

await test("a repeated id is the profile unchanged, not a duplicate", async () => {
  const { profile } = await addModel(seeded.id, { id: "smart-2", label: "Something else" });
  assert.deepEqual(profile?.models.map((m) => m.id), ["smart-1", "smart-2"]);
  assert.equal(profile?.models[1]?.label, "Smart 2", "the stored label wins over the re-sent one");
});

await test("an unknown profile is refused", async () => {
  assert.equal((await addModel("nope", { id: "x", label: "x" })).error, "unknown profile");
});

await test("the redacted answer the client gets carries no key", async () => {
  const body = redact((await getProfile(seeded.id))!) as Record<string, unknown>;
  assert.equal(body.apiKey, undefined);
  assert.equal(body.hasApiKey, true);
  assert.deepEqual((body.usage as { hasApiKey: boolean }).hasApiKey, true);
});

await test("the save schema keeps a model's user-written picker fields", async () => {
  /* The routes parse the form's body through ProfileInputSchema before it
     reaches updateProfile/createProfile, and a Zod object strips what it does
     not name — so a field the client sends and the schema omits is dropped on
     save with no error at all. A model's `group` (the picker heading) and
     `iconUrl` are exactly that: declared here or the group a user typed never
     reaches the row. */
  const parsed = ProfileInputSchema.parse({
    name: "gateway",
    agents: { "claude-code": {} },
    models: [
      { id: "fast", label: "Fast", reasoningEfforts: [], group: "Speed", iconUrl: "https://models.dev/logos/x.svg" },
    ],
  });
  assert.equal(parsed.models[0]?.group, "Speed", "a typed group survives the parse");
  assert.equal(parsed.models[0]?.iconUrl, "https://models.dev/logos/x.svg");
});

await test("the save schema keeps a model's kind and wire", async () => {
  /* The same stripping rule, for the one field pair that decides where a model
     may be offered: `kind`/`wire` (docs/plans/model-kinds.md). A decision model
     that came back as a chat model is one a thread is started on, so the shape
     has to survive a save untouched — and an entry that names neither still
     reads as the chat model it was. */
  const parsed = ProfileInputSchema.parse({
    name: "decision",
    agents: { daedalus: {} },
    models: [
      { id: "jev-1.13.0", label: "Jev 1.13", reasoningEfforts: [], kind: "decision", wire: "systemone" },
      { id: "chat-model", label: "Chat", reasoningEfforts: [] },
    ],
  });
  assert.equal(parsed.models[0]?.kind, "decision");
  assert.equal(parsed.models[0]?.wire, "systemone");
  assert.equal(parsed.models[1]?.kind, undefined, "absent stays absent, so an old entry is unchanged");
});

await test("a model's kind survives the write and the read-back", async () => {
  await addModel(seeded.id, { id: "jev-1.13.0", label: "Jev 1.13", kind: "decision", wire: "systemone" });
  const stored = (await getProfile(seeded.id))!.models.find((m) => m.id === "jev-1.13.0");
  assert.equal(stored?.kind, "decision", "the kind reached the jsonb column");
  assert.equal(stored?.wire, "systemone");
});

await test("the save schema keeps a model's peak schedule", async () => {
  /* Third time for the same stripping rule, and the one with the quietest
     failure: a schedule dropped on save is a badge the composer simply never
     draws, which reads as "this model has no peak pricing" rather than as a
     bug. Free-form on purpose (`peak.ts`) — the sentence is the user's. */
  const parsed = ProfileInputSchema.parse({
    name: "deepseek",
    agents: { daedalus: {} },
    models: [
      {
        id: "deepseek-v4-pro",
        label: "V4 Pro",
        reasoningEfforts: [],
        peak: { windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC", when: "peak", multiplier: 2 },
      },
      { id: "flat", label: "Flat", reasoningEfforts: [] },
    ],
  });
  assert.deepEqual(parsed.models[0]?.peak, {
    windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC",
    when: "peak",
    multiplier: 2,
  });
  assert.equal(parsed.models[1]?.peak, undefined, "absent stays absent, so a flat model is unchanged");
});

await test("a peak schedule survives the write and the read-back", async () => {
  await addModel(seeded.id, { id: "peaky", label: "Peaky" });
  const before = (await exportProfile(seeded.id, false))!;
  const updated = await updateProfile(seeded.id, {
    ...before,
    apiKey: "",
    models: before.models.map((m) =>
      m.id === "peaky"
        ? { ...m, peak: { windows: "22:00-08:00 Asia/Shanghai", when: "off-peak" as const, multiplier: 0.5 } }
        : m,
    ),
  });
  const stored = updated!.models.find((m) => m.id === "peaky");
  assert.equal(stored?.peak?.windows, "22:00-08:00 Asia/Shanghai", "the sentence reached the jsonb column");
  assert.equal(stored?.peak?.when, "off-peak");
  assert.equal(stored?.peak?.multiplier, 0.5);
});

await test("the model test refuses a model whose kind is not chat", async () => {
  /* `/test-model` sends a chat completion. A decision model answers System One,
     and the gateway's own refusal ("ModelProtocolUnsupported") reads like a
     broken row rather than a test that cannot ask — so the refusal is ours,
     before anything is spent, and it names the kind. */
  await addModel(seeded.id, { id: "jev-1.13-free", label: "Jev", kind: "decision", wire: "systemone" });
  const app = new Hono();
  profileRoutes(app, { sessions: {} as never });
  const post = (body: unknown) =>
    app.request(`/api/profiles/${seeded.id}/test-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const refused = await post({ model: "jev-1.13-free" });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /decision model/);

  /* An unsaved row says the same thing from its own body, before it is stored. */
  const unsaved = await post({ model: "brand-new", kind: "completion" });
  assert.equal(unsaved.status, 400);
  assert.match(((await unsaved.json()) as { error: string }).error, /completion model/);
});

/* Duplicating has the same credential bargain: the copy is made server-side
   precisely so it carries the keys the client never held. */
await test("a duplicate carries the credentials and lands hidden", async () => {
  const copy = (await duplicateProfile(seeded.id))!;
  assert.notEqual(copy.id, seeded.id, "a copy is a new row");
  assert.equal(copy.name, "gateway (copy)");
  assert.equal(copy.apiKey, "sk-secret", "the key is copied — the whole reason this is server-side");
  assert.equal(copy.usage?.apiKey, "sk-usage");
  assert.equal(copy.baseUrl, seeded.baseUrl);
  assert.deepEqual(copy.models.map((m) => m.id), (await getProfile(seeded.id))!.models.map((m) => m.id));
  assert.equal(copy.hidden, true, "the copy stays out of the pickers until it is edited");
});

await test("a virtual profile has nothing to duplicate", async () => {
  assert.equal(await duplicateProfile("default:claude-code"), undefined);
  assert.equal(await duplicateProfile("nope"), undefined);
});

await test("profile sync excludes secrets by default and preserves destination credentials", async () => {
  const exported = await exportProfile(seeded.id, false);
  assert.ok(exported);
  assert.equal(exported.apiKey, "");
  assert.equal(exported.usage?.apiKey, "");

  const id = "sync:source-profile";
  const first = await syncProfile(id, exported, false);
  assert.equal(first?.apiKey, "");
  assert.equal(first?.usage?.apiKey, "");

  const withSecrets = await exportProfile(seeded.id, true);
  assert.equal(withSecrets?.apiKey, "sk-secret");
  const copied = await syncProfile(id, withSecrets!, true);
  assert.equal(copied?.apiKey, "sk-secret");
  assert.equal(copied?.usage?.apiKey, "sk-usage");

  const updatedWithoutSecrets = { ...exported, name: "gateway updated" };
  const updated = await syncProfile(id, updatedWithoutSecrets, false);
  assert.equal(updated?.name, "gateway updated");
  assert.equal(updated?.apiKey, "sk-secret");
  assert.equal(updated?.usage?.apiKey, "sk-usage");
  assert.equal(await syncProfile("not-sync-id", exported, false), undefined);
});

await db.delete(profilesTable);

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);

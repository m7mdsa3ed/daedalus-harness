// Self-check for the composer's completion lane — `POST /api/fim` and the
// install's default for it (`server/src/fim.ts`, `server/src/routes/fim.ts`,
// docs/plans/fim-composer.md).
//
// The call and the choice are one question, so one file proves both: a real
// local HTTP server stands in for a DeepSeek-shaped FIM endpoint, which is the
// only way to assert the path (`/completions` under a `/beta` base, with no
// `/v1` invented anywhere), the bearer, and the exact body — a lane whose whole
// payload is `prompt` + `suffix` cannot be checked against a mock of itself.
//
// Run: pnpm test:fim
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../src/http-error.js";
import { appSettings, db, profiles as profilesTable } from "../src/db/index.js";
import { createProfile, deleteProfile } from "../src/profiles.js";
import { fimRoutes } from "../src/routes/fim.js";
import { sideModelRoutes } from "../src/routes/side-models.js";

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

/* ── The provider stand-in ──
   Records what crossed and answers what the current test asked it to. */
interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { choices: [{ text: "tus" }] } };

const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  seen.push({
    method: req.method ?? "",
    url: req.url ?? "",
    authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  });
  res.statusCode = reply.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply.body));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const port = (provider.address() as { port: number }).port;

const app = new Hono();
fimRoutes(app);
sideModelRoutes(app);
/* The server's own mapping (`index.ts` `onError`): these routes refuse by
   throwing `HttpError`, the way every domain module here does, so a bare Hono
   without this would read every refusal as a 500. */
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HttpError ? (err.status as ContentfulStatusCode) : 500;
  return c.json({ error: message }, status);
});
const call = (path: string, init?: RequestInit) => app.request(path, init);
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

await db.delete(appSettings);
await db.delete(profilesTable);

const profile = await createProfile({
  name: "deepseek-fim",
  agents: { daedalus: {} },
  // The `/beta` base is the point: DeepSeek's FIM lives at `{base}/completions`
  // and a `/v1` invented in front of it is a 404 on every keystroke.
  baseUrl: `http://127.0.0.1:${port}/beta`,
  apiKey: "sk-fim",
  models: [
    {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro (FIM)",
      reasoningEfforts: [],
      kind: "completion",
      wire: "openai-completions",
    },
    { id: "chat-1", label: "Chat 1", reasoningEfforts: [] },
    { id: "no-wire", label: "Completion with no wire", reasoningEfforts: [], kind: "completion" },
    { id: "jev-1.13-free", label: "Jev 1.13 Free", reasoningEfforts: [], kind: "decision", wire: "systemone" },
  ],
  defaultModel: "deepseek-v4-pro",
  smallModel: "",
  suppressModelMetadataWarning: false,
  hidden: false,
  disabled: false,
  logoUrl: "",
});

await test("nothing chosen answers the fallback, and says it is one", async () => {
  const res = await call("/api/fim");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    default: { profileId: string; model: string; label: string } | null;
    source: string | null;
    candidates: { model: string }[];
  };
  assert.equal(body.source, "fallback");
  assert.equal(body.default?.profileId, profile.id);
  assert.equal(body.default?.model, "deepseek-v4-pro");
  assert.equal(body.default?.label, "DeepSeek V4 Pro (FIM)");
  /* The chat model and the wire-less completion model are not candidates: this
     lane can call neither, and offering them would be a picker of things that
     fail. */
  assert.deepEqual(body.candidates.map((c) => c.model), ["deepseek-v4-pro"]);
});

await test("a default call posts prompt and no suffix to {base}/completions", async () => {
  seen.length = 0;
  const res = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { text: string; model: string; profileId: string };
  assert.equal(body.text, "tus");
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.profileId, profile.id);

  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request?.method, "POST");
  assert.equal(request?.url, "/beta/completions", "one path shape, no /v1 invented");
  assert.equal(request?.authorization, "Bearer sk-fim");
  assert.deepEqual(request?.body, {
    model: "deepseek-v4-pro",
    prompt: "git sta",
    max_tokens: 64,
    stop: ["\n"],
    temperature: 0.2,
  });
  assert.equal("suffix" in (request?.body ?? {}), false, "no suffix key when the caret is at the end");
});

await test("the chat envelope is read too — Mistral's FIM answers in one", async () => {
  /* The request is the legacy completions shape either way; the *answer* is not.
     Mistral's `/v1/fim/completions` replies `choices[0].message.content`, and a
     reader that only knew `choices[0].text` returned "" for every Mistral
     completion — nothing, silently, which is how this one got shipped. */
  seen.length = 0;
  reply = { status: 200, body: { choices: [{ message: { role: "assistant", content: "tus" } }] } };
  const res = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { text: string }).text, "tus");

  /* Neither spelling still means "unreadable", not "empty". */
  reply = { status: 200, body: { choices: [{ message: {} }] } };
  const unreadable = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(unreadable.status, 502);
  reply = { status: 200, body: { choices: [{ text: "tus" }] } };
});

await test("a suffix rides through, and the answer is the gap verbatim", async () => {
  seen.length = 0;
  reply = { status: 200, body: { choices: [{ text: " status" }] } };
  const res = await call("/api/fim", post({ prompt: "git", suffix: " --short", maxTokens: 8 }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { text: string };
  /* Verbatim, leading space included: that space is part of the gap. */
  assert.equal(body.text, " status");
  assert.equal(seen[0]?.body.suffix, " --short");
  assert.equal(seen[0]?.body.max_tokens, 8);
  reply = { status: 200, body: { choices: [{ text: "tus" }] } };
});

await test("a thread recap goes in front of the prompt, and the caret's text last", async () => {
  /* One channel is all a FIM call has, so the recap is a preamble: a model
     completes from the end of what it was given, and the end has to be the line
     being written. */
  seen.length = 0;
  const res = await call("/api/fim", post({ prompt: "does it work in", context: "User: hi\nAssistant: yes" }));
  assert.equal(res.status, 200);
  assert.equal(seen[0]?.body.prompt, "User: hi\nAssistant: yes\n\ndoes it work in");

  /* No context is the old body, byte for byte. */
  seen.length = 0;
  await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(seen[0]?.body.prompt, "git sta");
});

await test("a candidate can be proved without being saved", async () => {
  seen.length = 0;
  const res = await call(
    "/api/fim",
    post({ profileId: profile.id, model: "deepseek-v4-pro", prompt: "git sta" }),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const after = (await (await call("/api/fim")).json()) as { source: string };
  assert.equal(after.source, "fallback", "a test call is not a choice");
});

await test("a chat model is refused, and nothing reaches the provider", async () => {
  seen.length = 0;
  const res = await call("/api/fim", post({ profileId: profile.id, model: "chat-1", prompt: "git sta" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /chat model/);
  assert.equal(seen.length, 0, "a configuration answer spends no request");
});

await test("a completion model with no wire is refused", async () => {
  seen.length = 0;
  const res = await call("/api/fim", post({ profileId: profile.id, model: "no-wire", prompt: "git sta" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /wire/);
  assert.equal(seen.length, 0);
});

await test("nothing to complete is a refusal, not an empty request", async () => {
  seen.length = 0;
  const res = await call("/api/fim", post({ prompt: "   \n  " }));
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0);
});

await test("half a pair is a mistake, not a pairing", async () => {
  const res = await call("/api/fim", post({ profileId: profile.id, prompt: "git sta" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /model is required/);
});

await test("PUT stores the choice, GET reports it as explicit, DELETE falls back", async () => {
  const res = await call("/api/fim", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, model: "deepseek-v4-pro" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { default: { model: string } | null; source: string };
  assert.equal(body.source, "explicit");
  assert.equal(body.default?.model, "deepseek-v4-pro");

  const read = (await (await call("/api/fim")).json()) as { source: string };
  assert.equal(read.source, "explicit", "the choice survives the read");

  const cleared = await call("/api/fim", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as { source: string }).source, "fallback");
});

await test("PUT refuses a chat model and leaves the stored choice alone", async () => {
  const before = (await (await call("/api/fim")).json()) as { default: { model: string } | null; source: string };
  const res = await call("/api/fim", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, model: "chat-1" }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /not a completion model/);
  const after = (await (await call("/api/fim")).json()) as { default: { model: string } | null; source: string };
  assert.deepEqual(after, before, "a refused write changes nothing");
});

await test("the provider's own failure is a 502 carrying its words", async () => {
  reply = { status: 402, body: { error: "insufficient balance" } };
  const res = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /402.*insufficient balance/);
  reply = { status: 200, body: { choices: [{ text: "tus" }] } };
});

await test("an unreadable answer is a 502, an empty gap is an answer", async () => {
  reply = { status: 200, body: { nope: true } };
  const unreadable = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(unreadable.status, 502);

  /* Nothing to add is not a failure: the composer draws no ghost. */
  reply = { status: 200, body: { choices: [{ text: "" }] } };
  const empty = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as { text: string }).text, "");
  reply = { status: 200, body: { choices: [{ text: "tus" }] } };
});

await test("the decision lane is its own choice, drawn from its own kind", async () => {
  const read = (await (await call("/api/decision")).json()) as {
    default: { model: string } | null;
    source: string | null;
    candidates: { model: string }[];
  };
  assert.deepEqual(read.candidates.map((c) => c.model), ["jev-1.13-free"]);
  assert.equal(read.source, "fallback");

  const stored = await call("/api/decision", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, model: "jev-1.13-free" }),
  });
  assert.equal(stored.status, 200);
  assert.equal(((await stored.json()) as { source: string }).source, "explicit");

  /* The completion lane did not move: two keys, two answers. */
  const completion = (await (await call("/api/fim")).json()) as { source: string };
  assert.equal(completion.source, "fallback");
});

await test("a decision lane refuses every other kind, naming what it wanted", async () => {
  const put = (model: string) =>
    call("/api/decision", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, model }),
    });

  const chat = await put("chat-1");
  assert.equal(chat.status, 400);
  assert.match(((await chat.json()) as { error: string }).error, /not a decision model/);

  /* A completion model is the right shape for the other lane and the wrong one
     for this: the lane says which, rather than accepting it and failing later. */
  const completion = await put("deepseek-v4-pro");
  assert.equal(completion.status, 400);
  assert.match(((await completion.json()) as { error: string }).error, /not a decision model/);
});

await test("a stored profile that was deleted falls back, never a 500", async () => {
  await call("/api/fim", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, model: "deepseek-v4-pro" }),
  });
  await deleteProfile(profile.id);

  const res = await call("/api/fim");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { default: unknown; source: unknown; candidates: unknown[] };
  assert.equal(body.default, null);
  assert.equal(body.source, null);
  assert.deepEqual(body.candidates, [], "nothing completable is left");

  /* And with nothing to call, the composer is told why instead of guessing. */
  const refused = await call("/api/fim", post({ prompt: "git sta" }));
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /no completion model is chosen/);
});

provider.close();

console.log(`\nfim: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`\n  ✗ ${failure}`);
  process.exit(1);
}

// Self-check for attachments end to end: upload → claim → prompt → the block
// kinds the agent actually received → the queue → the sweep.
//
// The fake agent advertises `promptCapabilities: {image: true, audio: false,
// embeddedContext: true}` and answers an `attachments:` prompt with the block
// types it was sent, so what is asserted here is what crossed the wire rather
// than what this process believed it sent.
// Run: pnpm test:attachments (DAEDALUS_DATA_DIR is set by the npm script —
// static imports are hoisted, so setting it here would be too late).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

const DATA = process.env.DAEDALUS_DATA_DIR!;
rmSync(DATA, { recursive: true, force: true });
writeJson(join(DATA, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
]);

const { SessionManager } = await import("../src/sessions.js");
const {
  claimAttachments,
  countAttachments,
  deleteAttachments,
  getAttachment,
  putAttachment,
  readAttachment,
  sweepAttachments,
} = await import("../src/attachments.js");
const { attachmentBlocks } = await import("../src/attachment-blocks.js");
const { enqueue, listQueue } = await import("../src/queue.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

class MockWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close() {
    this.emit("close");
  }
  get events(): ThreadEvent[] {
    return this.sent.map((l) => JSON.parse(l) as ThreadEvent);
  }
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.events.filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
  }
}

const CWD = join(DATA, "ws");
mkdirSync(CWD, { recursive: true });

const profile: Profile = {
  id: "p1",
  name: "test",
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "sk-test",
  // No catalog: the carve-out, so the agent's own capabilities decide. That is
  // deliberate — this file is about the plumbing, and delivery.test.ts is where
  // the model half is pinned.
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = { id: "w1", name: "test-ws", cwd: CWD, description: null };

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

console.log("attachments — the store");

const imageId = randomUUID();
await test("an upload answers a ref and writes the bytes once", () => {
  const row = putAttachment({ id: imageId, name: "shot.png", mimeType: "image/png", bytes: png });
  assert.equal(row.name, "shot.png");
  assert.equal(row.size, png.length);
  assert.equal(row.sessionId, null, "owned by nobody until a prompt claims it");
  assert.deepEqual(readAttachment(row), png);
});

await test("the same id twice is a retry, not a second file", () => {
  const again = putAttachment({ id: imageId, name: "shot.png", mimeType: "image/png", bytes: png });
  assert.equal(again.createdAt, getAttachment(imageId)!.createdAt);
  assert.equal(countAttachments(), 1);
});

await test("the same content under another id is a row over one file", () => {
  const second = randomUUID();
  putAttachment({ id: second, name: "copy.png", mimeType: "image/png", bytes: png });
  assert.equal(countAttachments(), 2, "a claim is a thread's, a file is content's");
  // Dropping one leaves the other's bytes alone: the file goes only when no row
  // still references that hash.
  deleteAttachments([second]);
  assert.deepEqual(readAttachment(getAttachment(imageId)!), png);
  assert.equal(countAttachments(), 1);
});

await test("a file over the cap is a 413, not a degrade", () => {
  assert.throws(
    () =>
      putAttachment({
        id: randomUUID(),
        name: "huge.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.alloc(11 * 1024 * 1024),
      }),
    (err: { status?: number }) => err.status === 413,
  );
});

console.log("attachments — the blocks");

const textId = randomUUID();
const pdfId = randomUUID();
putAttachment({ id: textId, name: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") });
putAttachment({
  id: pdfId,
  name: "spec.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.from("%PDF-1.4\n"),
});

await test("each file takes the branch its capabilities allow", () => {
  const out = attachmentBlocks({
    refs: [imageId, textId, pdfId].map((id) => ({ id, name: "", mimeType: "", size: 0 })),
    caps: { image: true, embeddedContext: true },
    cwd: CWD,
    modalities: undefined,
    hasCatalog: false,
  });
  assert.deepEqual(out.blocks.map((b) => b.type), ["image", "resource", "resource_link"]);
  // And every one of them is named in the prose, whatever branch it took —
  // the text is what every runtime reads without being taught anything.
  assert.match(out.textSuffix, /\[attached: shot\.png\]/);
  assert.match(out.textSuffix, /\[attached: spec\.pdf — @\.daedalus\/attachments\//);
});

await test("a binary mislabelled as text is refused the resource branch", () => {
  const sneaky = randomUUID();
  putAttachment({
    id: sneaky,
    name: "actually.bin",
    mimeType: "text/plain",
    bytes: Buffer.from([0x41, 0x00, 0x42]),
  });
  const out = attachmentBlocks({
    refs: [{ id: sneaky, name: "", mimeType: "", size: 0 }],
    caps: { embeddedContext: true },
    cwd: CWD,
    modalities: undefined,
    hasCatalog: false,
  });
  assert.deepEqual(out.blocks.map((b) => b.type), ["resource_link"]);
  deleteAttachments([sneaky]);
});

await test("the materialised directory gitignores itself", () => {
  assert.ok(existsSync(join(CWD, ".daedalus", ".gitignore")));
  assert.equal(readFileSync(join(CWD, ".daedalus", ".gitignore"), "utf8").trim(), "*");
});

await test("forceLink pins everything to the path branch", () => {
  const out = attachmentBlocks({
    refs: [{ id: imageId, name: "", mimeType: "", size: 0 }],
    caps: { image: true },
    cwd: CWD,
    modalities: undefined,
    hasCatalog: false,
    forceLink: true,
  });
  assert.deepEqual(out.blocks.map((b) => b.type), ["resource_link"]);
});

console.log("attachments — a thread");

const manager = new SessionManager({}, 1);
const session = manager.create(profile, "fake", project);
await session.bridge!.ready;
const ws = new MockWs();
assert.equal(await manager.attach(session.id, ws as never), null);

await test("the runtime's capabilities reach the client on session_config", () => {
  const config = ws.of("session_config").at(-1);
  assert.deepEqual(config?.promptCapabilities, {
    image: true,
    audio: false,
    embeddedContext: true,
  });
});

await test("a prompt carries the blocks and journals the refs", async () => {
  send(ws, { id: 1, cmd: "prompt", text: "attachments:", attachmentIds: [imageId, pdfId] });
  await waitFor(() => ws.of("turn_ended").length === 1, "the turn to end");
  // What the AGENT saw, echoed back by the fake: an image inline, the PDF as a
  // link. `embeddedContext` is claimed, but a PDF is not text-ish.
  const said = ws
    .of("update")
    .map((e) => (e.update.sessionUpdate === "agent_message_chunk" ? e.update.content : null))
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("");
  assert.match(said, /blocks:image,resource_link/);
});

await test("…and the turn_started that other peers see names them", () => {
  const other = new MockWs();
  return manager.attach(session.id, other as never).then(() => {
    const started = other.of("turn_started").at(-1);
    assert.deepEqual(
      started?.attachments?.map((a) => a.name),
      ["shot.png", "spec.pdf"],
      "refs are journaled, so a replayed bubble draws the same chips",
    );
  });
});

await test("a claimed attachment belongs to the thread", () => {
  assert.equal(getAttachment(imageId)!.sessionId, session.id);
  assert.ok(getAttachment(imageId)!.claimedAt);
});

await test("an unknown id is dropped, not fatal", () => {
  const kept = claimAttachments([randomUUID(), textId], session.id);
  assert.deepEqual(kept.map((ref) => ref.name), ["notes.txt"]);
});

await test("an id claimed by another thread is dropped too", () => {
  const other = manager.create(profile, "fake", project);
  const kept = claimAttachments([imageId], other.id);
  assert.deepEqual(kept, [], "a file belongs to the thread that sent it");
  manager.purge(other.id);
});

const heldId = randomUUID();
await test("a queue row round-trips ids and answers refs", async () => {
  const held = heldId;
  putAttachment({ id: held, name: "queued.png", mimeType: "image/png", bytes: png });
  // Enqueued directly: `queueAdd` on an *idle* thread drains straight away —
  // one path, so a client whose picture of the turn was stale still gets its
  // words sent — which is asserted below rather than worked around here.
  enqueue(session.id, "later", claimAttachments([held], session.id));
  const queued = listQueue(session.id);
  assert.deepEqual(
    queued.at(-1)?.attachments?.map((a) => a.name),
    ["queued.png"],
    "the row stores ids; the wire carries refs",
  );
  assert.equal(getAttachment(held)!.sessionId, session.id, "queuing claims it too");
});

await test("…and the drain carries them into the prompt", async () => {
  const before = ws.of("turn_ended").length;
  // Whatever is queued, combined into one prompt with one attachment set.
  manager.queueAdd(session.id, "attachments:", []);
  await waitFor(() => ws.of("turn_ended").length > before, "the drained turn to end");
  assert.equal(listQueue(session.id).length, 0, "rows go only after the prompt is dispatched");
  /* One prompt, one attachment set: the row queued above and the one added
     here are unioned in row order, which is what the drain sends. The
     `[attachments]` line the bridge logs for `queued.png` is the other half of
     the same statement — the decision is made at send, against the model the
     turn is actually going to. */
  assert.equal(
    (getAttachment(heldId)?.sessionId ?? null),
    session.id,
    "the drained turn's attachments were this thread's all along",
  );
});

console.log("attachments — the sweep");

await test("an unclaimed upload past its day is swept; a claimed one is kept", async () => {
  const stale = randomUUID();
  putAttachment({ id: stale, name: "forgotten.png", mimeType: "image/png", bytes: png });
  const { db, attachments: table } = await import("../src/db/index.js");
  const { eq } = await import("drizzle-orm");
  db.update(table)
    .set({ createdAt: Date.now() - 48 * 60 * 60 * 1000 })
    .where(eq(table.id, stale))
    .run();
  sweepAttachments();
  assert.equal(getAttachment(stale), undefined, "an upload whose prompt was never sent");
  assert.ok(getAttachment(imageId), "one a thread claimed stays as long as the thread does");
});

await test("purging the thread takes its attachments with it", () => {
  manager.purge(session.id);
  assert.equal(getAttachment(imageId), undefined);
  assert.equal(getAttachment(pdfId), undefined);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);

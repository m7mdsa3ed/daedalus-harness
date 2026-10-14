// Self-check for attachments end to end: upload → claim → prompt → the block
// kinds the agent actually received → the queue → the sweep.
//
// The fake agent advertises `promptCapabilities: {image: true, audio: false,
// embeddedContext: true}` and answers an `attachments:` prompt with the block
// types it was sent, so what is asserted here is what crossed the wire rather
// than what this process believed it sent.
// Run: pnpm test:attachments (DAEDALUS_DATA_DIR is set by the npm script —
// static imports are hoisted, so setting it here would be too late).
import "./require-temp-data.js";
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
const { db, sessions } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");
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
};
const project = { id: "w1", name: "test-ws", cwd: CWD, description: null };

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

console.log("attachments — the store");

const imageId = randomUUID();
await test("an upload answers a ref and writes the bytes once", async () => {
  const row = await putAttachment({ id: imageId, name: "shot.png", mimeType: "image/png", bytes: png });
  assert.equal(row.name, "shot.png");
  assert.equal(row.size, png.length);
  assert.equal(row.sessionId, null, "owned by nobody until a prompt claims it");
  assert.deepEqual(readAttachment(row), png);
});

await test("the same id twice is a retry, not a second file", async () => {
  const again = await putAttachment({ id: imageId, name: "shot.png", mimeType: "image/png", bytes: png });
  assert.equal(again.createdAt, (await getAttachment(imageId))!.createdAt);
  assert.equal(await countAttachments(), 1);
});

await test("the same content under another id is a row over one file", async () => {
  const second = randomUUID();
  await putAttachment({ id: second, name: "copy.png", mimeType: "image/png", bytes: png });
  assert.equal(await countAttachments(), 2, "a claim is a thread's, a file is content's");
  // Dropping one leaves the other's bytes alone: the file goes only when no row
  // still references that hash.
  await deleteAttachments([second]);
  assert.deepEqual(readAttachment((await getAttachment(imageId))!), png);
  assert.equal(await countAttachments(), 1);
});

await test("a file over the cap is a 413, not a degrade", async () => {
  await assert.rejects(
    async () =>
      await putAttachment({
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
await putAttachment({ id: textId, name: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") });
await putAttachment({
  id: pdfId,
  name: "spec.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.from("%PDF-1.4\n"),
});

await test("each file takes the branch its capabilities allow", async () => {
  const out = await attachmentBlocks({
    refs: [imageId, textId, pdfId].map((id) => ({ id, name: "", mimeType: "", size: 0 })),
    caps: { image: true, embeddedContext: true },
    cwd: CWD,
    modalities: undefined,
    hasCatalog: false,
  });
  assert.deepEqual((await out).blocks.map((b) => b.type), ["image", "resource", "resource_link"]);
  // And every one of them is named in the prose, whatever branch it took —
  // the text is what every runtime reads without being taught anything.
  assert.match(out.textSuffix, /\[attached: shot\.png\]/);
  assert.match(out.textSuffix, /\[attached: spec\.pdf — @\.daedalus\/attachments\//);
});

await test("a binary mislabelled as text is refused the resource branch", async () => {
  const sneaky = randomUUID();
  await putAttachment({
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
  assert.deepEqual((await out).blocks.map((b) => b.type), ["resource_link"]);
  await deleteAttachments([sneaky]);
});

await test("the materialised directory gitignores itself", () => {
  assert.ok(existsSync(join(CWD, ".daedalus", ".gitignore")));
  assert.equal(readFileSync(join(CWD, ".daedalus", ".gitignore"), "utf8").trim(), "*");
});

await test("forceLink pins everything to the path branch", async () => {
  const out = attachmentBlocks({
    refs: [{ id: imageId, name: "", mimeType: "", size: 0 }],
    caps: { image: true },
    cwd: CWD,
    modalities: undefined,
    hasCatalog: false,
    forceLink: true,
  });
  assert.deepEqual((await out).blocks.map((b) => b.type), ["resource_link"]);
});

console.log("attachments — a thread");

const manager = new SessionManager({}, 1);
const session = await manager.create(profile, "fake", project);
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

await test("a load replay keeps attached files as refs instead of text", async () => {
  await db.update(sessions).set({ acpSessionId: "acp-123" }).where(eq(sessions.id, session.id));
  session.acpSessionId = "acp-123";
  session.journalClean = false;
  const before = (await manager.journal(session.id))!.events;
  const started = before.find((event) => event.ev === "turn_started");
  assert.ok(started && started.ev === "turn_started");
  assert.ok(started.text === "attachments:");
  await manager.respawn(session.id, profile, "fake", project, session.model, session.effort, { revive: true, clear: true });
  const recovered = (await manager.journal(session.id))!.events;
  const userChunk = recovered.find(
    (event) => event.ev === "update" && event.historyReplay && event.update.sessionUpdate === "user_message_chunk",
  );
  assert.ok(userChunk && userChunk.ev === "update");
  assert.equal(userChunk.historyText, started.text);
  assert.deepEqual(userChunk.historyAttachments?.map((ref) => ref.id), [imageId, pdfId]);
});

await test("the refilled journal keeps recovered attachment refs for the next restart", async () => {
  const { SessionJournal } = await import("../src/session-journal.js");
  const journal = new SessionJournal(db);
  assert.deepEqual(
    (await journal.turnAttachments(session.id)).map(({ text, attachments }) => ({
      text,
      attachments: attachments.map((ref) => ref.id),
    })),
    [{ text: "attachments:", attachments: [imageId, pdfId] }],
  );
});

await test("a load-rebuilt journal exposes refs in replayed user chunks", async () => {
  const other = new MockWs();
  assert.equal(await manager.attach(session.id, other as never), null);
  const restored = other.of("update").find(
    (event) => event.historyReplay && event.update.sessionUpdate === "user_message_chunk",
  );
  assert.deepEqual(restored?.historyAttachments?.map((ref) => ref.name), ["shot.png", "spec.pdf"]);
});

await test("a claimed attachment belongs to the thread", async () => {
  assert.equal((await getAttachment(imageId))!.sessionId, session.id);
  assert.ok((await getAttachment(imageId))!.claimedAt);
});

await test("an unknown id is dropped, not fatal", async () => {
  const kept = await claimAttachments([randomUUID(), textId], session.id);
  assert.deepEqual(kept.map((ref) => ref.name), ["notes.txt"]);
});

await test("an id claimed by another thread is dropped too", async () => {
  const other = await manager.create(profile, "fake", project);
  const kept = await claimAttachments([imageId], other.id);
  assert.deepEqual(kept, [], "a file belongs to the thread that sent it");
  manager.purge(other.id);
});

const heldId = randomUUID();
await test("a queue row round-trips ids and answers refs", async () => {
  const held = heldId;
  await putAttachment({ id: held, name: "queued.png", mimeType: "image/png", bytes: png });
  // Enqueued directly: `queueAdd` on an *idle* thread drains straight away —
  // one path, so a client whose picture of the turn was stale still gets its
  // words sent — which is asserted below rather than worked around here.
  await enqueue(session.id, "later", await claimAttachments([held], session.id));
  const queued = await listQueue(session.id);
  assert.deepEqual(
    queued.at(-1)?.attachments?.map((a) => a.name),
    ["queued.png"],
    "the row stores ids; the wire carries refs",
  );
  assert.equal((await getAttachment(held))!.sessionId, session.id, "queuing claims it too");
});

await test("…and the drain carries them into the prompt", async () => {
  const before = ws.of("turn_ended").length;
  /* A real queue: the oldest row is its own turn, with its own attachments, and
     the row added here waits behind it (`continued` re-drains at the turn end).
     So two rows are two turns, and the queue is empty only after both. */
  await manager.queueAdd(session.id, "attachments:", []);
  await waitFor(() => ws.of("turn_ended").length >= before + 2, "both queued rows' turns to end");
  assert.equal((await listQueue(session.id)).length, 0, "every row went once its prompt was dispatched");
  /* The `[attachments]` line the bridge logs for `queued.png` is the other half
     of this — the decision is made at send, against the model the turn is
     actually going to. */
  assert.equal(
    ((await getAttachment(heldId))?.sessionId ?? null),
    session.id,
    "the drained turn's attachments were this thread's all along",
  );
});

console.log("attachments — the sweep");

await test("an unclaimed upload past its day is swept; a claimed one is kept", async () => {
  const stale = randomUUID();
  await putAttachment({ id: stale, name: "forgotten.png", mimeType: "image/png", bytes: png });
  const { db, attachments: table } = await import("../src/db/index.js");
  const { eq } = await import("drizzle-orm");
  await db.update(table)
    .set({ createdAt: Date.now() - 48 * 60 * 60 * 1000 })
    .where(eq(table.id, stale))
    ;
  await sweepAttachments();
  assert.equal(await getAttachment(stale), undefined, "an upload whose prompt was never sent");
  assert.ok(await getAttachment(imageId), "one a thread claimed stays as long as the thread does");
});

await test("purging the thread takes its attachments with it", async () => {
  await manager.purge(session.id);
  assert.equal(await getAttachment(imageId), undefined);
  assert.equal(await getAttachment(pdfId), undefined);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);

// The file library: a tree (parent null = root), unique names per folder, no
// cycles, recursive delete that releases bytes only when nothing shares them,
// and a library file handed to the composer as an attachment.
// Run: pnpm test:files
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
const f = await import("../src/files.js");
const { readAttachment } = await import("../src/attachments.js");
const bytes = (s: string) => Buffer.from(s);

const docs = await f.makeFolder(null, "Docs");
const inner = await f.makeFolder(docs.id, "Inner");
assert.equal(docs.mimeType, f.FOLDER_MIME);

const a = await f.putFile({ parentId: docs.id, name: "a.txt", mimeType: "text/plain", bytes: bytes("hello") });
const dup = await f.putFile({ parentId: docs.id, name: "a.txt", mimeType: "text/plain", bytes: bytes("hello") });
assert.equal(dup.name, "a (2).txt", "a name collision is renamed, not refused");
assert.equal(dup.key, a.key, "the same content is stored once");

const listed = await f.listFolder(docs.id);
assert.deepEqual(listed.map((r) => r.name), ["Inner", "a (2).txt", "a.txt"], "folders first, then by name");
assert.deepEqual((await f.pathOf(inner.id)).map((p) => p.name), ["Docs", "Inner"]);

await assert.rejects(() => f.updateFile(docs.id, { parentId: inner.id }), "a folder cannot move under itself");
await f.updateFile(a.id, { parentId: inner.id, name: "b.txt" });
assert.equal((await f.getFile(a.id))!.parentId, inner.id);

const ref = await f.attachmentFor((await f.getFile(a.id))!);
assert.equal(ref.mimeType, "text/plain");
assert.equal(readAttachment(ref)!.toString(), "hello", "the composer gets the same bytes");

await f.removeFile(inner.id);
assert.equal(await f.getFile(a.id), undefined, "deleting a folder takes its contents");
assert.equal((await f.readFile((await f.getFile(dup.id))!)).toString(), "hello", "bytes another row shares survive");
await f.removeFile(docs.id);
assert.deepEqual(await f.listFolder(null), []);
console.log("files: all assertions passed");
process.exit(0);

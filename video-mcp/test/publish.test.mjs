// Mock of the harness Files routes on node:http. Run after `pnpm build`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishVideo } from "../dist/tools/publish.js";

const rows = []; // {id,parentId,kind,name}
const uploads = [];
const deletes = [];
let seq = 0;
let refuse413 = false;
let fail500 = false;
let failDelete = false;
const parentOf = (u) => u.searchParams.get("parent") || null;

const srv = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && u.pathname === "/api/files") return send(200, { items: rows.filter((r) => r.parentId === parentOf(u)) });
  if (req.method === "POST" && u.pathname === "/api/files/folder") {
    const b = JSON.parse(body.toString());
    const row = { id: `f${++seq}`, parentId: b.parentId, kind: "folder", name: b.name };
    rows.push(row);
    return send(201, row);
  }
  if (req.method === "POST" && u.pathname === "/api/files") {
    if (refuse413) return send(413, { error: "that file is larger than 25MB" });
    if (fail500) return send(500, { error: "disk on fire" });
    // like the real server: a clash is kept as "name (2)"
    let name = decodeURIComponent(req.headers["x-filename"]);
    if (rows.some((r) => r.parentId === parentOf(u) && r.name === name)) name = name.replace(/\.mp4$/, " (2).mp4");
    const row = { id: `f${++seq}`, parentId: parentOf(u), kind: "file", name };
    rows.push(row);
    uploads.push({ body, type: req.headers["content-type"], filename: req.headers["x-filename"], row });
    return send(201, row);
  }
  const del = /^\/api\/files\/([^/]+)$/.exec(u.pathname);
  if (req.method === "PATCH" && del) {
    const row = rows.find((r) => r.id === del[1]);
    row.name = JSON.parse(body.toString()).name;
    return send(200, row);
  }
  if (req.method === "DELETE" && del) {
    if (failDelete) return send(500, { error: "cannot delete" });
    deletes.push(del[1]);
    rows.splice(rows.findIndex((r) => r.id === del[1]), 1);
    return send(200, { ok: true });
  }
  send(404, { error: "nope" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const harnessUrl = `http://127.0.0.1:${srv.address().port}`;

const cwd = mkdtempSync(join(tmpdir(), "publish-test-"));
try {
  const out = join(cwd, ".daedalus", "videos", "demo", "out");
  mkdirSync(out, { recursive: true });
  const bytes = randomBytes(200_000); // arbitrary binary: must arrive byte for byte
  writeFileSync(join(out, "demo-draft.mp4"), bytes);

  const r1 = await publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl });
  assert.equal(r1.published, true);
  assert.equal(r1.folder, "Videos/demo");
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].body.equals(bytes), "bytes intact");
  assert.equal(uploads[0].type, "video/mp4");
  assert.equal(uploads[0].filename, "demo-draft.mp4");
  assert.equal(r1.fileId, uploads[0].row.id);
  const folders = rows.filter((r) => r.kind === "folder");
  assert.deepEqual(folders.map((f) => [f.name, f.parentId]), [["Videos", null], ["demo", folders[0].id]]);
  assert.equal(uploads[0].row.parentId, folders[1].id);

  // re-publish: folders reused, old file deleted, one copy left
  const r2 = await publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl });
  assert.equal(rows.filter((r) => r.kind === "folder").length, 2);
  assert.deepEqual(deletes, [r1.fileId]);
  assert.equal(rows.filter((r) => r.kind === "file").length, 1);
  assert.notEqual(r2.fileId, r1.fileId);

  assert.equal(r2.message.includes("Warning"), false);
  assert.equal(rows.find((r) => r.id === r2.fileId).name, "demo-draft.mp4", "renamed back after the old copy went");

  // upload fails (500): the old copy must still be there, nothing deleted
  fail500 = true;
  const delBefore = deletes.length;
  await assert.rejects(publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl }), /failed \(500\)/);
  fail500 = false;
  assert.equal(deletes.length, delBefore);
  assert.ok(rows.some((r) => r.id === r2.fileId), "old file survives a failed upload");

  // delete fails after a good upload: warn, do not throw, and the new copy is reported
  failDelete = true;
  const r2b = await publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl });
  failDelete = false;
  assert.equal(r2b.published, true);
  assert.match(r2b.message, /Warning.*could not be removed/);
  for (const dup of rows.filter((r) => r.kind === "file" && r.id !== r2b.fileId)) rows.splice(rows.indexOf(dup), 1);

  // a name needing percent-encoding in a custom folder path
  writeFileSync(join(out, "demo-final.mp4"), bytes);
  const r3 = await publishVideo({ cwd, name: "demo", quality: "final", folder: "Q1/launch", harnessUrl });
  assert.equal(r3.folder, "Videos/Q1/launch");

  // harness refuses with 413
  refuse413 = true;
  const r4 = await publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl });
  assert.equal(r4.published, false);
  assert.match(r4.message, /too large/);
  refuse413 = false;

  // over the cap locally: no request at all
  const before = uploads.length;
  writeFileSync(join(out, "demo-final.mp4"), Buffer.alloc(26 * 1024 * 1024));
  const r5 = await publishVideo({ cwd, name: "demo", quality: "final", harnessUrl });
  assert.equal(r5.published, false);
  assert.match(r5.message, /25 MB/);
  assert.equal(uploads.length, before);

  // no harness
  delete process.env.HARNESS_URL;
  const r6 = await publishVideo({ cwd, name: "demo", quality: "draft" });
  assert.equal(r6.published, false);
  assert.match(r6.message, /HARNESS_URL/);

  // other failures surface the body text, not secrets
  await assert.rejects(publishVideo({ cwd, name: "demo", quality: "draft", harnessUrl: harnessUrl + "/bad" }), /failed \(404\)/);
  await assert.rejects(publishVideo({ cwd, name: "nothing", quality: "draft", harnessUrl }), /does not exist/);
  console.log("publish ok");
} finally {
  srv.close();
  rmSync(cwd, { recursive: true, force: true });
}

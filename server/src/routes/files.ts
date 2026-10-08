import type { Hono } from "hono";

import { refOf } from "../attachments.js";
import {
  MAX_FILE_BYTES,
  attachmentFor,
  getFile,
  listFolder,
  makeFolder,
  pathOf,
  putFile,
  readFile,
  removeFile,
  updateFile,
} from "../files.js";
import { HttpError } from "../http-error.js";

/**
 * The file library. Behind the bearer middleware like every `/api/*` route, so
 * the bytes are fetched with a header and shown from a blob URL — an `<img>`
 * cannot carry one.
 *
 * Upload is a **raw body**, as attachments are: `Content-Type` is the mime
 * type, `X-Filename` the percent-encoded name, `?parent=` the folder (absent =
 * the root).
 */
export function fileRoutes(app: Hono): void {
  const parentOf = (raw: string | undefined) => (raw && raw !== "root" ? raw : null);

  app.get("/api/files", async (c) => {
    const parentId = parentOf(c.req.query("parent"));
    return c.json({ parentId, path: await pathOf(parentId), items: await listFolder(parentId) });
  });

  app.post("/api/files/folder", async (c) => {
    const body = await c.req.json();
    return c.json(await makeFolder(parentOf(body.parentId), String(body.name ?? "")), 201);
  });

  app.post("/api/files", async (c) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      throw new HttpError(`that file is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`, 413);
    }
    let name = c.req.header("x-filename") ?? "file";
    try {
      name = decodeURIComponent(name);
    } catch {
      /* a malformed name is a name */
    }
    const row = await putFile({
      parentId: parentOf(c.req.query("parent")),
      name,
      mimeType: (c.req.header("content-type") ?? "").split(";")[0].trim(),
      bytes: Buffer.from(await c.req.arrayBuffer()),
    });
    return c.json(row, 201);
  });

  app.patch("/api/files/:id", async (c) => {
    const body = await c.req.json();
    return c.json(
      await updateFile(c.req.param("id"), {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...("parentId" in body ? { parentId: parentOf(body.parentId ?? undefined) } : {}),
      }),
    );
  });

  app.delete("/api/files/:id", async (c) => {
    await removeFile(c.req.param("id"));
    return c.json({ ok: true });
  });

  /* Same header set as `/api/attachments/:id`, for the same reason: user bytes
     served from the server's own origin. */
  app.get("/api/files/:id/content", async (c) => {
    const row = await getFile(c.req.param("id"));
    if (!row) return c.json({ error: "no such file" }, 404);
    return c.body((await readFile(row)) as unknown as ArrayBuffer, 200, {
      "Content-Type": row.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  /** The composer's door: the file as a prompt attachment. */
  app.post("/api/files/:id/attach", async (c) => {
    const row = await getFile(c.req.param("id"));
    if (!row) return c.json({ error: "no such file" }, 404);
    return c.json(refOf(await attachmentFor(row)), 201);
  });
}

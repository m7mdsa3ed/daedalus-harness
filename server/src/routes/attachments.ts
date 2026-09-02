import type { Hono } from "hono";

import {
  MAX_ATTACHMENT_BYTES,
  deleteAttachments,
  getAttachment,
  putAttachment,
  readAttachment,
  refOf,
} from "../attachments.js";
import { HttpError } from "../http-error.js";

/**
 * Upload, fetch and drop the bytes a prompt can carry.
 *
 * Registered under `/api/*`, so it is behind the bearer middleware — unlike
 * `/gw` and `/ide`, this route has no child process for a caller and no reason
 * to leave the fence.
 *
 * The upload is a **raw body, not multipart**: `Content-Type` is the mime type,
 * `X-Filename` is the percent-encoded name and `X-Attachment-Id` is the id the
 * client minted (like a session id). Nothing in this codebase parses multipart
 * today, and adding a parser to accept one file per request is a dependency
 * bought for nothing.
 */
export function attachmentRoutes(app: Hono): void {
  app.post("/api/attachments", async (c) => {
    const id = c.req.header("x-attachment-id");
    if (!id) throw new HttpError("X-Attachment-Id is required", 400);

    /* The length is checked before the body is read where the client declares
       one: refusing a 200MB upload after receiving it is 200MB spent on an
       answer that was always going to be 413. */
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(
        `that file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`,
        413,
      );
    }

    const bytes = Buffer.from(await c.req.arrayBuffer());
    const row = putAttachment({
      id,
      name: decodeName(c.req.header("x-filename")),
      mimeType: (c.req.header("content-type") ?? "").split(";")[0].trim(),
      bytes,
    });
    return c.json(refOf(row), 201);
  });

  /* The bytes. Same header set as `/file-raw` (routes/workspace.ts), and for
     the same reason: the server is serving user-controlled bytes from its own
     origin, and an uploaded file is more of that, not less. */
  app.get("/api/attachments/:id", (c) => {
    const row = getAttachment(c.req.param("id"));
    if (!row) return c.json({ error: "no such attachment" }, 404);
    const bytes = readAttachment(row);
    // A row whose file is gone — a restored backup, whose bundles deliberately
    // carry no attachment bytes. 404 is what the chip draws as "missing".
    if (!bytes) return c.json({ error: "that attachment's bytes are gone" }, 404);
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": row.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  /** A chip removed before send. After send the row belongs to the thread and
      goes with it (`softDelete`/`purge`). */
  app.delete("/api/attachments/:id", (c) => {
    const row = getAttachment(c.req.param("id"));
    if (!row) return c.json({ error: "no such attachment" }, 404);
    if (row.sessionId) throw new HttpError("that attachment has already been sent", 409);
    deleteAttachments([row.id]);
    return c.json({ ok: true });
  });
}

/** Percent-encoded, so a name with a space or a non-ASCII character survives a
    header — and a malformed one is a name, not a 500. */
function decodeName(raw: string | undefined): string {
  if (!raw) return "file";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

import type { AttachmentRef } from "@daedalus/protocol"

import { ApiError, type ServerSettings } from "./settings"

/* ── Attachments, from the browser's side ──
   Upload, delete, and fetch bytes for a chip. Three routes, no state: what the
   composer is holding lives in `lib/composer-attachments-state.ts`'s sidecar
   beside the draft, exactly as a parked paste does.

   The upload is a **raw body**, not multipart: `Content-Type` is the mime type,
   `X-Filename` is the percent-encoded name and `X-Attachment-Id` is an id this
   end mints — like a session id, and for the same reason. An attachment is
   uploaded before the session exists (a thread is a draft until its first
   message), so it is owned by nobody until the prompt that references it claims
   it.

   Raw `fetch` throughout rather than `api()`: the upload is a `File` body with
   the mime type as `Content-Type` and the download is bytes handed to the DOM
   as a blob, neither of which `api()`'s JSON-in/JSON-out shape can express. So
   the bearer header is written out here, which is also why the connection is an
   explicit argument on every one of these — the same shape `api()` has. */

/** Mirrors the server's `MAX_ATTACHMENT_BYTES`. Checked here too so a 40MB file
    is refused before it is uploaded, not after. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Mirrors the server's `MAX_ATTACHMENTS`. */
export const MAX_ATTACHMENTS = 10

/** `12.4 KB`. The size on a chip is a rough scale, not an audit — one decimal
    past KB, none below it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

async function failure(response: Response, path: string): Promise<ApiError> {
  const body = await response.text().catch(() => "")
  let message = body.trim() || undefined
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === "string") message = parsed.error
  } catch {
    /* not JSON — the raw text is the message */
  }
  return new ApiError({ status: response.status, path, serverMessage: message })
}

export async function uploadAttachment(
  settings: ServerSettings,
  id: string,
  file: File,
  signal?: AbortSignal
): Promise<AttachmentRef> {
  const response = await fetch(new URL("/api/attachments", settings.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.token}`,
      // A browser will hand `File.type` an empty string for anything it does
      // not recognise; the server's own fallback is the same one.
      "content-type": file.type || "application/octet-stream",
      "x-attachment-id": id,
      // Percent-encoded: a header may not carry a newline, a non-ASCII
      // character or a stray quote, and a filename may carry all three.
      "x-filename": encodeURIComponent(file.name || "file"),
    },
    body: file,
    signal,
  })
  if (!response.ok) throw await failure(response, "/api/attachments")
  return (await response.json()) as AttachmentRef
}

/** A chip removed before send. After send the row belongs to the thread. */
export async function deleteAttachment(settings: ServerSettings, id: string): Promise<void> {
  const path = `/api/attachments/${encodeURIComponent(id)}`
  const response = await fetch(new URL(path, settings.url), {
    method: "DELETE",
    headers: { authorization: `Bearer ${settings.token}` },
  })
  // Already gone is the state we were asking for.
  if (!response.ok && response.status !== 404) throw await failure(response, path)
}

/**
 * A blob URL for an attachment's bytes.
 *
 * A bearer-header `fetch` rather than an `<img src>`, for the reason
 * `readFileObjectUrl` gives: an `<img>` cannot carry the header, and a
 * `?token=` in a `src` puts the credential in every referrer and cache key.
 * The caller owns the URL and must revoke it.
 */
export async function attachmentObjectUrl(
  settings: ServerSettings,
  id: string,
  signal?: AbortSignal
): Promise<string> {
  const path = `/api/attachments/${encodeURIComponent(id)}`
  const response = await fetch(new URL(path, settings.url), {
    headers: { authorization: `Bearer ${settings.token}` },
    signal,
  })
  if (!response.ok) throw await failure(response, path)
  return URL.createObjectURL(await response.blob())
}

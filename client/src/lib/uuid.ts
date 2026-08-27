/* ── uuid ──
   `crypto.randomUUID` exists only in a SECURE CONTEXT — https, or localhost.
   Serve this app off a LAN address over plain http, which is exactly how you
   reach it from a phone on the same network, and the function is simply not
   there: "crypto.randomUUID is not a function".

   That is not a corner case here. The client MINTS session ids (a new thread is
   a route change, not a round trip — see CLAUDE.md), so without this the app
   cannot start a thread at all on the one setup it is most likely to be used
   from. `crypto.getRandomValues` is NOT restricted to secure contexts, so the
   fallback is still cryptographically random; the last resort exists only so a
   missing `crypto` object cannot take the app down with it.

   The server validates these — `POST /api/sessions` rejects anything that is
   not a UUID — so the shape is not cosmetic: version (4) and variant bits are
   set exactly as randomUUID would. */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === "function") return c.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

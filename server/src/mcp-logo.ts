/* ── An MCP server's logo, fetched here and handed to the browser inline ──
   The browser used to load a server's logo itself — from the server's own
   host, or from Google's favicon service — which told a third party which MCP
   servers you run, on every device, on every load. It is fetched once, by this
   machine, when the listing is read, and travels inside that listing as a
   `data:` URL (`mcp_catalog`, same TTL), so showing it costs the browser no
   request at all. */

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 4000;

/** One image, or null: https only, an `image/*` answer, small. A failure is an
    absent logo, never an error — the mark underneath is the fallback. */
async function fetchImage(url: string): Promise<string | null> {
  try {
    if (!url.startsWith("https://")) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The first logo that answers: what the server declared in its initialize
 * answer, then its own origin's favicon, then the favicon service — asked by
 * this machine, so the service sees the harness and not the reader.
 */
export async function resolveMcpLogo(declared: string | undefined, endpoint: string | undefined): Promise<string | null> {
  if (declared?.startsWith("data:image/")) return declared;
  if (declared) {
    const inline = await fetchImage(declared);
    if (inline) return inline;
  }
  if (!endpoint) return null;
  let host: URL;
  try {
    host = new URL(endpoint);
  } catch {
    return null;
  }
  if (host.protocol !== "https:") return null;
  return (
    (await fetchImage(`${host.origin}/favicon.ico`)) ??
    (await fetchImage(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host.hostname)}&sz=64`))
  );
}

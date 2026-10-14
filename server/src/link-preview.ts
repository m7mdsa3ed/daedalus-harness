/* ── A link's title and mark, fetched here ──
   A URL pasted into the composer is drawn as a chip, and the chip wants to say
   what the link *is* rather than show a bare address. So the page's own title
   and image are read **by this machine** and handed to the browser inside the
   answer — the same bargain `mcp-logo.ts` makes for MCP servers: the reader's
   browser asks nobody, and the page is fetched once per URL, not once per
   device.

   Never throws: a link that will not load is a link with no title, which is a
   chip wearing its hostname. Nothing here is stored — an in-memory LRU is
   enough for a read whose only job is to save a second fetch. */

import { fetchImage } from "./mcp-logo.js";
import { stripTags } from "./websearch.js";

const TIMEOUT_MS = 4000;
/* A page can be any size and this is a trust boundary — an arbitrary URL a
   person pasted. Never buffer the whole body; the head is where title and
   image live and it is at the front. */
const MAX_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

export interface LinkPreview {
  url: string;
  title?: string;
  /** The page's image, inlined as a `data:` URL. */
  image?: string;
}

/** First attribute value, whichever order `property`/`content` come in. */
function metaContent(html: string, key: string): string | undefined {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const both = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`,
    "i",
  );
  const m = both.exec(html);
  return (m?.[1] ?? m?.[2])?.trim() || undefined;
}

/** The head's title: `og:title`, else the document title. Both are HTML — the
    entities in them are decoded and the tags stripped (`stripTags`). */
function pageTitle(html: string): string | undefined {
  const raw = metaContent(html, "og:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const clean = raw ? stripTags(raw) : "";
  return clean || undefined;
}

/** The URL to a page's image: `og:image`, else its icon — resolved against the
    page so a relative path is fetchable. */
function pageImage(html: string, pageUrl: string): string | undefined {
  const raw =
    metaContent(html, "og:image") ??
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']*)["']/i.exec(html)?.[1];
  if (!raw) return undefined;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return undefined;
  }
}

/** Read at most `MAX_BYTES` of a response body, then stop. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text;
}

const cache = new Map<string, { at: number; value: LinkPreview }>();

async function fetchPreview(url: string): Promise<LinkPreview> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || (type && !type.includes("html"))) return { url };
  const html = await readCapped(response);
  const title = pageTitle(html);
  const imageUrl = pageImage(html, response.url || url);
  const image = imageUrl ? await fetchImage(imageUrl) : null;
  return { url, ...(title ? { title } : {}), ...(image ? { image } : {}) };
}

/**
 * A page's title and inlined image, or just its URL. http(s) only, including
 * localhost and a LAN address — the harness runs where the person's dev server
 * runs (`probePreview` makes the same bet), so a link to one's own tunnel is
 * still worth a title. The image fetch itself stays https (`fetchImage`), so a
 * plain-http page gets its title and no mark.
 */
export async function resolveLinkPreview(url: string): Promise<LinkPreview> {
  if (!/^https?:\/\//i.test(url)) return { url };
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Re-insert so the newest entries are the survivors when the map is full.
    cache.delete(url);
    cache.set(url, hit);
    return hit.value;
  }
  let value: LinkPreview;
  try {
    value = await fetchPreview(url);
  } catch {
    value = { url };
  }
  cache.set(url, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

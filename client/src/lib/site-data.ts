/* ── Site data, and what a page can actually clear ──
   Two jobs, and the line between them is the point of this file.

   **Clearable from here.** Everything this origin stored: the Workbox
   precache (Cache Storage), the service worker registration itself, the
   localStorage this client keeps its whole device-local state in, and any
   IndexedDB a dependency opened. A stale precache is the failure worth having a
   button for — the shell is served from cache before the network is consulted,
   so a build that half-updated, or a worker left behind by an earlier tunnel
   hostname, keeps serving an app that no reload can replace.

   **NOT clearable from here: the TLS certificate.** No web API can drop a
   certificate, a certificate exception, or an HSTS entry — that state lives in
   the browser profile, deliberately out of reach of the sites it protects, and
   a page that could clear it could also clear the warning it earned. So the
   UI does not pretend to; it reports what it CAN see (see `inspectSecurity`)
   and says where the browser's own control is.

   Which matters here because "Chrome says we are not https" is almost never the
   certificate. Far more often the page is https and something ON it is not, and
   the one thing that reliably does that in this app is a server URL entered as
   `http://` — see the mixed-content finding below. */
import { loadServers, type ServerSettings } from "./settings"

export interface SiteDataReport {
  /** Cache Storage buckets deleted (the Workbox precache and runtime caches). */
  caches: number
  /** Service worker registrations unregistered. */
  workers: number
  /** IndexedDB databases deleted. */
  databases: number
  /** localStorage keys removed. */
  keys: number
}

const empty = (): SiteDataReport => ({ caches: 0, workers: 0, databases: 0, keys: 0 })

/**
 * Drop the offline shell: every Cache Storage bucket and every service worker
 * registered on this origin.
 *
 * This is the repair for a bad precache, and it is deliberately the *smaller*
 * of the two: it does not touch localStorage, so the server URL, the token,
 * drafts, pins and themes all survive. The caller must reload afterwards — an
 * unregistered worker keeps controlling the page it already controls until the
 * last tab on the origin goes away.
 */
export async function clearAppCache(): Promise<SiteDataReport> {
  const report = empty()

  if ("caches" in window) {
    try {
      const names = await caches.keys()
      // Failures are per-bucket: one wedged cache must not strand the others.
      const deleted = await Promise.all(names.map((name) => caches.delete(name).catch(() => false)))
      report.caches = deleted.filter(Boolean).length
    } catch {
      // No Cache Storage (private mode, an old browser) is the same as none to clear.
    }
  }

  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations()
      const gone = await Promise.all(
        registrations.map((registration) => registration.unregister().catch(() => false))
      )
      report.workers = gone.filter(Boolean).length
    } catch {
      // Same reasoning: nothing to unregister is not a failure.
    }
  }

  return report
}

/**
 * Everything above, plus every byte this origin stored — localStorage,
 * sessionStorage and IndexedDB.
 *
 * This **disconnects the device**: the server URL and token live in
 * localStorage (`daedalus.servers`), as do drafts, pins, themes and the cached
 * push token. The caller is expected to have confirmed, and to reload into the
 * connect screen afterwards.
 *
 * The push registration is retired FIRST and over the network, because it is
 * the one piece of this state the server also holds: dropping the local token
 * without telling the server leaves it pushing to a device that has forgotten
 * why (the case `teardownPush` exists for). Best-effort — an unreachable server
 * must not block a local clear, which is often exactly why someone is here.
 */
export async function clearAllSiteData(): Promise<SiteDataReport> {
  const servers = safeServers()
  await Promise.all(
    servers.map(async (server) => {
      try {
        const { teardownPush } = await import("./push")
        await teardownPush(server)
      } catch {
        // Offline, or the server is gone. The row ages out server-side.
      }
    })
  )

  const report = await clearAppCache()

  try {
    report.keys = localStorage.length
    localStorage.clear()
  } catch {
    // Storage denied — nothing was stored either.
  }
  try {
    sessionStorage.clear()
  } catch {
    // As above.
  }

  report.databases = await clearIndexedDb()
  return report
}

/** `indexedDB.databases()` is Chromium/Safari-only; Firefox cannot enumerate,
    so there is nothing to delete by name and the count is honestly zero. */
async function clearIndexedDb(): Promise<number> {
  const factory = window.indexedDB as (IDBFactory & { databases?: () => Promise<{ name?: string }[]> }) | undefined
  if (!factory?.databases) return 0
  try {
    const databases = await factory.databases()
    const deleted = await Promise.all(
      databases.map(
        (database) =>
          new Promise<boolean>((resolve) => {
            if (!database.name) return resolve(false)
            const request = factory.deleteDatabase(database.name)
            request.onsuccess = () => resolve(true)
            request.onerror = () => resolve(false)
            // A database still open in another tab blocks forever otherwise.
            request.onblocked = () => resolve(false)
          })
      )
    )
    return deleted.filter(Boolean).length
  } catch {
    return 0
  }
}

function safeServers(): ServerSettings[] {
  try {
    return loadServers()
  } catch {
    return []
  }
}

/* ── Security diagnostics ── */

export interface SecurityFinding {
  level: "ok" | "warn" | "error"
  title: string
  detail: string
}

/**
 * Why the browser does or does not treat this page as secure.
 *
 * `isSecureContext` is the browser's own answer and the gate on everything the
 * PWA needs — service worker, install, push — so it leads. The mixed-content
 * check is the one that explains the usual complaint: an https page that talks
 * to `http://`/`ws://` is not "https with a warning", it is a page whose
 * requests Chrome blocks outright while marking it Not secure. `dev:tunnel`
 * exists to tunnel BOTH halves for exactly this reason.
 */
export function inspectSecurity(): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const pageSecure = window.isSecureContext
  const https = location.protocol === "https:"

  findings.push(
    pageSecure
      ? {
          level: "ok",
          title: "Secure context",
          detail: `This page is a secure context (${location.protocol}//${location.host}), so service workers, install and push are all permitted.`,
        }
      : {
          level: "error",
          title: "Not a secure context",
          detail: `${location.protocol}//${location.host} is not https and is not localhost, so the browser blocks service workers, installing and notifications outright. Serve the app over https — see pnpm dev:tunnel.`,
        }
  )

  // The part a page CAN detect about "it says we aren't https": what we point at.
  for (const server of safeServers()) {
    const url = parseUrl(server.url)
    if (!url) {
      findings.push({
        level: "warn",
        title: `${server.name}: unreadable URL`,
        detail: `"${server.url}" could not be parsed as a URL.`,
      })
      continue
    }
    const insecureTarget = url.protocol === "http:" || url.protocol === "ws:"
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)
    if (https && insecureTarget && !loopback) {
      findings.push({
        level: "error",
        title: `${server.name}: mixed content`,
        detail: `This page is https but the server is ${url.protocol}//${url.host}. Chrome blocks that request and marks the page Not secure — which is what "we're https but it doesn't think so" looks like. Point this at an https:// URL (tunnel the server too).`,
      })
    } else {
      findings.push({
        level: "ok",
        title: `${server.name}: transport`,
        detail: `${url.protocol}//${url.host} — no mixed content with this page.`,
      })
    }
  }

  const originFinding = inspectOrigin()
  if (originFinding) findings.push(originFinding)

  const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null
  findings.push(
    controller
      ? {
          level: "ok",
          title: "Service worker active",
          detail: `Controlled by ${new URL(controller.scriptURL).pathname}.`,
        }
      : {
          level: "warn",
          title: "No service worker controlling this page",
          detail: pageSecure
            ? "Normal on the very first load, and in the desktop shell, which ships none. If it persists, clearing the app cache below and reloading re-registers it."
            : "Expected — a service worker needs a secure context.",
        }
  )

  return findings
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/* Origins that are https and yet a bad place to install from.

   Installing a PWA on Android is not a bookmark: Chrome and Samsung Internet
   ask Google to mint a real signed APK (a WebAPK) for the origin. That drags in
   Play Protect and Safe Browsing, which judge the DOMAIN, not the page — so a
   shared throwaway-tunnel domain with a reputation for delivering malware gets
   the install blocked ("Unsafe app blocked" is Android saying so, not the
   browser) no matter how correct the manifest is.

   The other half is that these hostnames are single-use. A PWA's identity is
   its origin, so an app installed from one is pinned to a name that stops
   resolving when the tunnel restarts.

   Detected here because the alternative is guessing at a certificate problem
   that isn't one. */
const EPHEMERAL_ORIGINS: { match: RegExp; name: string }[] = [
  { match: /(^|\.)trycloudflare\.com$/i, name: "a Cloudflare quick tunnel" },
  { match: /(^|\.)ngrok(-free)?\.(app|io|dev)$/i, name: "an ngrok tunnel" },
  { match: /(^|\.)loca\.lt$/i, name: "a localtunnel" },
  { match: /(^|\.)serveo\.net$/i, name: "a Serveo tunnel" },
]

function inspectOrigin(): SecurityFinding | null {
  const { hostname } = location
  const ephemeral = EPHEMERAL_ORIGINS.find((entry) => entry.match.test(hostname))
  if (ephemeral) {
    return {
      level: "error",
      title: "Throwaway hostname — installing will fail",
      detail: `This page is served from ${ephemeral.name}. Android installs a PWA as a generated APK, so Play Protect judges the domain: these shared tunnel domains are heavily abused and commonly blocked, which is what "Unsafe app blocked" and a browser refusing to install mean. The hostname is also single-use, so an install made here breaks when the tunnel restarts. Serve the app from a stable name with its own certificate — pnpm dev:serve puts it on your tailnet.`,
    }
  }
  // A bare IP can hold a certificate but never a WebAPK, and it is not a name
  // the manifest's scope can survive either.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) {
    return {
      level: "warn",
      title: "Served from an IP address",
      detail: "Browsers will not install a PWA from a bare IP. Use a hostname with a real certificate — pnpm dev:serve.",
    }
  }
  return null
}

/* ── Routes ──
   The URL is the source of truth for navigation: one route per thread, so a
   reload, back/forward, a push deep link and an Electron window all land on the
   same screen. ponytail: History API, not a router dependency — three routes.

   /                     home (no thread open)
   /t/<sessionId>        one thread
   /settings/<section>   settings, one section per sidebar entry */
import * as React from "react"

export type Route =
  | { name: "home" }
  | { name: "thread"; sessionId: string }
  | { name: "settings"; section: string }

export function parseRoute(href: string): Route {
  const url = new URL(href, location.origin)
  // Legacy push deep link (/?session=<id>) — normalized to /t/<id> on open.
  const legacy = url.searchParams.get("session")
  if (legacy) return { name: "thread", sessionId: legacy }
  const [head, tail] = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
  if (head === "t" && tail) return { name: "thread", sessionId: decodeURIComponent(tail) }
  if (head === "settings") return { name: "settings", section: tail || "general" }
  return { name: "home" }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "thread":
      return `/t/${encodeURIComponent(route.sessionId)}`
    case "settings":
      return `/settings/${route.section}`
    default:
      return "/"
  }
}

const listeners = new Set<() => void>()
const emit = () => {
  for (const listener of listeners) listener()
}
window.addEventListener("popstate", emit)

export function navigate(route: Route, options?: { replace?: boolean }): void {
  const path = routePath(route)
  if (path === location.pathname + location.search) return
  history[options?.replace ? "replaceState" : "pushState"](null, "", path)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => location.pathname + location.search

export function useRoute(): Route {
  const href = React.useSyncExternalStore(subscribe, snapshot)
  return React.useMemo(() => parseRoute(href), [href])
}

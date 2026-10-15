/* ── Tabs ──
   A desktop keeps the threads and pages you are in as tabs, the way a browser
   does. **A tab is a route, not a layout**: the address bar says which tab is
   active, and a tab is just a thread or a page you have been to and not closed.
   There is no dock behind it — no splits, floats or panels to arrange; the tools
   about a tab live in the right panel (`lib/right-panel.ts`).

   Two kinds, because the app has always treated them differently:

   - **A thread is a tab of its own.** Opening one adds it (beside the tab you
     were on) and never replaces what you were reading; an open thread is
     focused, not duplicated.
   - **A page is a place you visit, not a thing you keep.** Every settings
     section is one tab whose path moves, and so is a project's page, the board,
     the inbox; going to another settings section repoints that tab.

   The landing page (`/`) is no tab: it is where you land with none open, and
   closing the last tab returns to it.

   Device-local, per server, and per window for a popout (which keeps its tabs in
   memory only). Reading is the untrusted path — a renamed field or a hand-edited
   key arrives looking like a tab — so every field is checked. */
import { matchPath } from "react-router"

import { createLocalStore, createStore, type Store } from "@/lib/local-store"
import { IS_POPOUT } from "@/lib/popout"
import { routedThreadId } from "@/lib/router"
import { loadSettings } from "@/lib/settings"

export interface Tab {
  /** `t:<sessionId>` for a thread; `p:<place>` for a page. */
  key: string
  /** The route this tab last showed (pathname plus search). */
  path: string
  /** Set on a thread tab. */
  sessionId?: string
}

const KEEP = 40

function parse(raw: unknown): Tab[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Tab[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    if (typeof e.key !== "string" || typeof e.path !== "string" || !e.path.startsWith("/")) continue
    if (seen.has(e.key)) continue
    seen.add(e.key)
    out.push({
      key: e.key,
      path: e.path,
      ...(typeof e.sessionId === "string" ? { sessionId: e.sessionId } : {}),
    })
  }
  return out.slice(-KEEP)
}

function makeStore(): Store<Tab[]> {
  if (IS_POPOUT || typeof window === "undefined") return createStore<Tab[]>([])
  return createLocalStore<Tab[]>(`daedalus.tabs.v1:${loadSettings()?.id ?? "none"}`, parse, [])
}

const store = makeStore()

/** Which place a route is. One per top-level section — `/settings/mcp` and
    `/settings/rules` are the same settings tab pointed elsewhere — except
    where the second segment names a *thing*: a project's page and a thread's
    trace are places of their own. */
export function pageKey(path: string): string {
  const [, first = "", second = "", third = ""] = path.split("?")[0].split("/")
  if (first === "projects" && second) return `projects/${second}`
  if (first === "t" && second) return third ? `t/${second}/${third}` : `t/${second}`
  return first || "home"
}

/** The tab a location belongs to, or null for the landing page (which has none). */
export function tabKeyFor(pathname: string, search: string): string | null {
  const thread = routedThreadId(pathname, search)
  if (thread) return `t:${thread}`
  if (pathname === "/") return null
  return `p:${pageKey(pathname)}`
}

/* ── Reading ── */

export function useTabs(): readonly Tab[] {
  return store.use()
}

export function getTabs(): readonly Tab[] {
  return store.get()
}

/* ── Writing ── */

/** Make the store agree with where the address bar is: add the thread tab or
    repoint the page tab. Idempotent — the route effect calls it on every change. */
export function syncTab(pathname: string, search: string): void {
  const key = tabKeyFor(pathname, search)
  if (!key) return
  const tabs = store.get()
  const path = pathname + search
  const at = tabs.findIndex((tab) => tab.key === key)
  if (at >= 0) {
    // A thread tab's path is always its own; only a page tab follows the route.
    if (key.startsWith("t:") || tabs[at].path === path) return
    const next = [...tabs]
    next[at] = { ...next[at], path }
    store.set(next)
    return
  }
  const sessionId = key.startsWith("t:") ? key.slice(2) : undefined
  /* Beside the tab you were on, not at the far end: a thread opened from
     another is read next to it. The previous active tab is the last one the
     store touched, which the caller does not know — so it goes at the end. */
  store.set([...tabs, { key, path: sessionId ? `/t/${encodeURIComponent(sessionId)}` : path, ...(sessionId ? { sessionId } : {}) }].slice(-KEEP))
}

/** Close a tab. Answers the path to show next when it was the one in front: its
    right neighbour, else its left, else the landing page. */
export function closeTab(key: string, activeKey: string | null): string | null {
  const tabs = store.get()
  const at = tabs.findIndex((tab) => tab.key === key)
  if (at < 0) return null
  const next = tabs.filter((tab) => tab.key !== key)
  store.set(next)
  if (key !== activeKey) return null
  const neighbour = next[at] ?? next[at - 1]
  return neighbour ? neighbour.path : "/"
}

export function moveTab(key: string, toIndex: number): void {
  const tabs = store.get()
  const from = tabs.findIndex((tab) => tab.key === key)
  if (from < 0) return
  const next = [...tabs]
  const [tab] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, tab)
  store.set(next)
}

/** Drop thread tabs whose thread is gone (purged, or never reached this
    server). The caller is responsible for not asking against a list that never
    arrived — an empty one would close every tab. */
export function pruneTabs(isLive: (sessionId: string) => boolean, keep: string | null): void {
  const tabs = store.get()
  const next = tabs.filter((tab) => !tab.sessionId || tab.key === keep || isLive(tab.sessionId))
  if (next.length !== tabs.length) store.set(next)
}

export function clearTabs(): void {
  store.set([])
}

/** The path a tab walk lands on: `delta` steps along, wrapping. */
export function adjacentTab(delta: number, activeKey: string | null): Tab | null {
  const tabs = store.get()
  if (tabs.length === 0) return null
  const at = tabs.findIndex((tab) => tab.key === activeKey)
  return tabs[(Math.max(at, 0) + delta + tabs.length) % tabs.length] ?? null
}

export function tabAt(index: number): Tab | null {
  return store.get()[index] ?? null
}

export const isThreadTabPath = (pathname: string) => !!matchPath("/t/:sessionId", pathname)

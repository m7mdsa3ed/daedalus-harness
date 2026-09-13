/* ── What the IDE has open ──
   The panel's tabs, per project, held in a module store rather than in the
   dock's descriptor or in React state.

   Not the descriptor, because a file open at line 42 is not a different panel
   from the same file open at line 9 — that was the mistake the old
   `{kind:"editor", projectId, path}` descriptor made, and `reveal.ts` existed
   only to work around it. The dock's descriptor is `{kind:"ide", projectId}`
   and stays that: what is open *inside* the IDE is the IDE's business.

   Not React state, because the dock unmounts a panel when its tab is closed or
   the layout is rearranged, and a set of open files with unsaved edits in them
   must survive that. The store outlives every mount, and — unlike the dock's
   own descriptor, which is restored per panel — the tabs written here are
   restored from `localStorage` too, so a reload brings back the files that
   were open. Unsaved text comes back the same way, through
   `lib/workspace/buffers.ts`.

   Subscribed to with `useSyncExternalStore`, so a component re-renders on the
   slice it actually read. */
import * as React from "react"

/* The one runtime import, and it is not the editor: `loadSettings` names the
   server the tabs are stored under. What the entry chunk must not carry is
   still type-only — `open.ts` and this file name nothing of Monaco. */
import { loadSettings } from "@/lib/settings"
import type { Comparison } from "@/lib/workspace/git-api"

export interface FileTab {
  kind: "file"
  /** Project-relative, POSIX. */
  path: string
}

/** A comparison names **both** its sides. Only saying which revision goes on
    the left forces the right to always be the working tree, and then a staged
    file's diff is HEAD ↔ worktree — it shows unstaged edits as part of what is
    about to be committed, which is the one question staging exists to answer. */
export interface DiffTab {
  kind: "diff"
  path: string
  left: Comparison
  right: Comparison
}

export type TabBody = FileTab | DiffTab

export interface Tab {
  /** Stable, derived from the body: opening the same thing twice focuses it. */
  id: string
  body: TabBody
}

/** Where a file tab should scroll to, and what to tint while it is there. */
export interface Reveal {
  line: number
  endLine?: number
  /** Bumped per request, so asking twice for the same line scrolls twice. */
  nonce: number
}

interface ProjectEditors {
  tabs: Tab[]
  activeId: string | null
  /** Tab ids whose buffer differs from disk. Drawn as the tab's dot, and what
      `closeTab` asks about. */
  dirty: ReadonlySet<string>
  reveals: Readonly<Record<string, Reveal>>
}

const EMPTY: ProjectEditors = { tabs: [], activeId: null, dirty: new Set(), reveals: {} }

const projects = new Map<string, ProjectEditors>()
const listeners = new Set<() => void>()

/* ── The tabs survive a reload ──
   The store above is what makes a set of open files outlive the panel; this is
   what makes it outlive the page. Keyed by server and then by project, on the
   same discipline as `lib/workspace/buffers.ts`: the blob is user-editable and
   written by some past build, so every tab is re-validated on the way in and a
   shape this build does not mean is dropped rather than trusted.

   Only the tabs and which one was in front are kept. A reveal is one-shot and a
   dirty flag is derived — the editor rebuilds both by re-reading the buffer,
   which is how it learns a file is dirty the first time. */
const KEY = "daedalus.ide.tabs.v1"

interface StoredProject {
  tabs?: unknown
  activeId?: unknown
}
type StoredTabs = Record<string, Record<string, StoredProject>>

const COMPARISONS = new Set<string>(["worktree", "staged", "head"])

const serverId = (): string => loadSettings()?.id ?? "none"

function readAll(): StoredTabs {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as StoredTabs
  } catch {
    /* Corrupt JSON reads as no tabs. There is nothing to tell the user — they
       get the IDE a first run gets. */
    return {}
  }
}

function writeAll(store: StoredTabs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch (error) {
    // Quota. The tabs still work; they just will not come back.
    console.warn("Could not persist the editor tabs", error)
  }
}

/** A tab body this build can mean, or null for one it cannot. */
function parseBody(raw: unknown): TabBody | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Record<string, unknown>
  if (typeof body.path !== "string" || body.path.length === 0) return null
  if (body.kind === "file") return { kind: "file", path: body.path }
  if (body.kind !== "diff") return null
  const left = body.left
  const right = body.right
  if (typeof left !== "string" || !COMPARISONS.has(left)) return null
  if (typeof right !== "string" || !COMPARISONS.has(right)) return null
  return { kind: "diff", path: body.path, left: left as Comparison, right: right as Comparison }
}

/** The stored tabs, rebuilt as live ones. Ids are derived, never stored. */
function parseTabs(entry: StoredProject | undefined): Tab[] {
  if (!entry || !Array.isArray(entry.tabs)) return []
  const tabs: Tab[] = []
  const seen = new Set<string>()
  for (const raw of entry.tabs) {
    const body = parseBody(raw)
    if (!body) continue
    const id = tabId(body)
    if (seen.has(id)) continue
    seen.add(id)
    tabs.push({ id, body })
  }
  return tabs
}

/** Write this project's tabs back, or drop the entry when it has none. */
function persist(projectId: string): void {
  const current = projects.get(projectId)
  const store = readAll()
  const server = serverId()
  const byProject = { ...(store[server] ?? {}) }
  if (!current || current.tabs.length === 0) delete byProject[projectId]
  else
    byProject[projectId] = {
      tabs: current.tabs.map((tab) => tab.body),
      activeId: current.activeId,
    }
  if (Object.keys(byProject).length === 0) delete store[server]
  else store[server] = byProject
  writeAll(store)
}

/* Read once, for the server that is active at start-up: the map is the live
   copy from here on, and a server switch rebuilds the app's state anyway. */
for (const [projectId, entry] of Object.entries(readAll()[serverId()] ?? {})) {
  const tabs = parseTabs(entry)
  if (tabs.length === 0) continue
  const stored = entry?.activeId
  const activeId =
    typeof stored === "string" && tabs.some((tab) => tab.id === stored)
      ? stored
      : (tabs[tabs.length - 1]?.id ?? null)
  projects.set(projectId, { tabs, activeId, dirty: new Set(), reveals: {} })
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function update(projectId: string, change: (current: ProjectEditors) => ProjectEditors): void {
  const current = projects.get(projectId) ?? EMPTY
  const next = change(current)
  if (next === current) return
  projects.set(projectId, next)
  /* Only the open set and the focus are worth a write: a reveal is one-shot and
     a dirty flag is derived, so neither belongs in what a reload restores. */
  if (next.tabs !== current.tabs || next.activeId !== current.activeId) persist(projectId)
  emit()
}

export function tabId(body: TabBody): string {
  switch (body.kind) {
    case "file":
      return `file:${body.path}`
    case "diff":
      return `diff:${body.left}:${body.right}:${body.path}`
  }
}

export function editorsOf(projectId: string): ProjectEditors {
  return projects.get(projectId) ?? EMPTY
}

export function subscribeEditors(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useEditors(projectId: string): ProjectEditors {
  return React.useSyncExternalStore(
    subscribeEditors,
    () => editorsOf(projectId),
    () => EMPTY
  )
}

/** Open a tab, or focus the one already showing it. Answers its id. */
export function openTab(projectId: string, body: TabBody, options: { reveal?: Omit<Reveal, "nonce"> } = {}): string {
  const id = tabId(body)
  update(projectId, (current) => {
    const known = current.tabs.some((tab) => tab.id === id)
    const reveals = options.reveal
      ? {
          ...current.reveals,
          [id]: { ...options.reveal, nonce: (current.reveals[id]?.nonce ?? 0) + 1 },
        }
      : current.reveals
    if (known && current.activeId === id && reveals === current.reveals) return current
    return {
      ...current,
      tabs: known ? current.tabs : [...current.tabs, { id, body }],
      activeId: id,
      reveals,
    }
  })
  return id
}

export function activateTab(projectId: string, id: string): void {
  update(projectId, (current) => (current.activeId === id ? current : { ...current, activeId: id }))
}

/**
 * Close a tab.
 *
 * The neighbour that takes focus is the one to the *right*, falling back to the
 * one to the left — the rule every editor uses, and the one that makes closing
 * a run of tabs feel like closing a run of tabs rather than jumping about.
 */
export function closeTab(projectId: string, id: string): void {
  update(projectId, (current) => {
    const at = current.tabs.findIndex((tab) => tab.id === id)
    if (at < 0) return current
    const tabs = current.tabs.filter((tab) => tab.id !== id)
    const activeId =
      current.activeId !== id
        ? current.activeId
        : (tabs[at]?.id ?? tabs[at - 1]?.id ?? null)
    const dirty = new Set(current.dirty)
    dirty.delete(id)
    const { [id]: _dropped, ...reveals } = current.reveals
    return { tabs, activeId, dirty, reveals }
  })
}

export function closeOtherTabs(projectId: string, id: string): void {
  update(projectId, (current) => {
    const kept = current.tabs.filter((tab) => tab.id === id)
    if (kept.length === current.tabs.length) return current
    const dirty = new Set([...current.dirty].filter((entry) => entry === id))
    return { tabs: kept, activeId: kept[0]?.id ?? null, dirty, reveals: {} }
  })
}

export function closeAllTabs(projectId: string): void {
  update(projectId, (current) => (current.tabs.length === 0 ? current : EMPTY))
}

/** A tab's buffer differs from disk (or no longer does). */
export function setTabDirty(projectId: string, id: string, dirty: boolean): void {
  update(projectId, (current) => {
    if (current.dirty.has(id) === dirty) return current
    const next = new Set(current.dirty)
    if (dirty) next.add(id)
    else next.delete(id)
    return { ...current, dirty: next }
  })
}

/** Taken by the editor once it has scrolled; a reveal happens once. */
export function consumeReveal(projectId: string, id: string): void {
  update(projectId, (current) => {
    if (!(id in current.reveals)) return current
    const { [id]: _taken, ...reveals } = current.reveals
    return { ...current, reveals }
  })
}

/** A project that is gone takes its tabs with it — the stored ones too, or a
    project reopened under the same id would come back to a set of files. */
export function forgetProjectEditors(projectId: string): void {
  const had = projects.delete(projectId)
  persist(projectId)
  if (had) emit()
}

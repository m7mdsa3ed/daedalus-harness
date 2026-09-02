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
   must survive that. The store outlives every mount; unsaved text survives a
   *reload* too, through `lib/workspace/buffers.ts`.

   Subscribed to with `useSyncExternalStore`, so a component re-renders on the
   slice it actually read. */
import * as React from "react"

export interface FileTab {
  kind: "file"
  /** Project-relative, POSIX. */
  path: string
}

export interface DiffTab {
  kind: "diff"
  path: string
  /** Which git side sits on the left. */
  comparison: "head" | "staged"
}

/** A turn's files, or everything uncommitted — the "N files changed" chip. */
export interface ChangesTab {
  kind: "changes"
  sessionId: string
  /** `turn:<id>` or `uncommitted`. */
  scope: string
}

export type TabBody = FileTab | DiffTab | ChangesTab

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

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function update(projectId: string, change: (current: ProjectEditors) => ProjectEditors): void {
  const current = projects.get(projectId) ?? EMPTY
  const next = change(current)
  if (next === current) return
  projects.set(projectId, next)
  emit()
}

export function tabId(body: TabBody): string {
  switch (body.kind) {
    case "file":
      return `file:${body.path}`
    case "diff":
      return `diff:${body.comparison}:${body.path}`
    case "changes":
      return `changes:${body.sessionId}:${body.scope}`
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

/** A project that is gone takes its tabs with it. */
export function forgetProjectEditors(projectId: string): void {
  if (!projects.has(projectId)) return
  projects.delete(projectId)
  emit()
}

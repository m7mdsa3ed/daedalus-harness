/* ── Where the Preview panel has been and what it holds open ──
   Pure, so it can be checked without a browser (`preview-nav.check.mjs`).

   Two things, kept apart on purpose. The **tabs** are the files the panel holds
   open — they travel in the descriptor, so a restored layout comes back with
   them. The **history** is the order they were looked at in: it is the panel's
   own state and is not saved, because a back button that survives a reload
   goes somewhere the reader no longer remembers. */

export interface PreviewHistory {
  stack: string[]
  /** -1 for an empty history. */
  index: number
}

export const EMPTY_HISTORY: PreviewHistory = { stack: [], index: -1 }

const HISTORY_CAP = 50

export const historyPath = (h: PreviewHistory): string | undefined => h.stack[h.index]
export const canGoBack = (h: PreviewHistory): boolean => h.index > 0
export const canGoForward = (h: PreviewHistory): boolean => h.index >= 0 && h.index < h.stack.length - 1

/** A new place was reached by any door but back and forward: what was ahead of
    the reader is gone, as in a browser. Looking at where you already are is not
    a visit. */
export function visit(h: PreviewHistory, path: string): PreviewHistory {
  if (historyPath(h) === path) return h
  const stack = [...h.stack.slice(0, h.index + 1), path].slice(-HISTORY_CAP)
  return { stack, index: stack.length - 1 }
}

export const goBack = (h: PreviewHistory): PreviewHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h)
export const goForward = (h: PreviewHistory): PreviewHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h)

/* ── Paths ── */

/** `path` is `dir` or lies under it. */
export const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

/** What a path becomes when `from` is renamed to `to` — itself, if it was not under `from`. */
export const remap = (path: string, from: string, to: string): string =>
  within(path, from) ? to + path.slice(from.length) : path

/** A history after a rename: the same places under their new names. */
export const remapHistory = (h: PreviewHistory, from: string, to: string): PreviewHistory => ({
  ...h,
  stack: h.stack.map((path) => remap(path, from, to)),
})

/** A history after paths were deleted: they are gone from it, and the reader
    stays on the nearest place that is left. */
export function dropFromHistory(h: PreviewHistory, gone: (path: string) => boolean): PreviewHistory {
  const stack: string[] = []
  let index = -1
  h.stack.forEach((path, i) => {
    if (gone(path)) return
    // Two neighbours that became adjacent are one stop.
    if (stack[stack.length - 1] === path) {
      if (i <= h.index) index = stack.length - 1
      return
    }
    stack.push(path)
    if (i <= h.index) index = stack.length - 1
  })
  return { stack, index: stack.length ? Math.max(index, 0) : -1 }
}

/* ── Tabs ── */

export const addTab = (tabs: readonly string[], file: string): string[] =>
  tabs.includes(file) ? [...tabs] : [...tabs, file]

export interface TabState {
  tabs: string[]
  file: string | undefined
}

/** Close one tab. If it was the one in front, the one that took its place is
    its right neighbour, else its left — a browser's rule. */
export function closeTab(tabs: readonly string[], file: string | undefined, closing: string): TabState {
  const i = tabs.indexOf(closing)
  if (i < 0) return { tabs: [...tabs], file: file === closing ? undefined : file }
  const next = tabs.filter((tab) => tab !== closing)
  if (file !== closing) return { tabs: next, file }
  return { tabs: next, file: next[i] ?? next[i - 1] }
}

/** Close every tab a predicate names — a deleted folder takes its files with it. */
export function dropTabs(tabs: readonly string[], file: string | undefined, gone: (path: string) => boolean): TabState {
  let state: TabState = { tabs: [...tabs], file }
  for (const tab of tabs) if (gone(tab)) state = closeTab(state.tabs, state.file, tab)
  if (state.file && gone(state.file)) state = { ...state, file: undefined }
  return state
}

/** The label a tab wears: its name, with its folder beside it only when
    another open tab has the same name. */
export function tabLabels(tabs: readonly string[]): { path: string; name: string; hint?: string }[] {
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1)
  const counts = new Map<string, number>()
  for (const tab of tabs) counts.set(name(tab), (counts.get(name(tab)) ?? 0) + 1)
  return tabs.map((path) => {
    const base = name(path)
    const dir = path.slice(0, Math.max(0, path.length - base.length - 1))
    const clash = (counts.get(base) ?? 0) > 1
    return { path, name: base, ...(clash && dir ? { hint: dir.slice(dir.lastIndexOf("/") + 1) } : {}) }
  })
}

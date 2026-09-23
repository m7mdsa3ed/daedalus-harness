/* ── The explorer's directory cache ──
   Everything about *reading* the tree: which directories have been listed,
   which are expanded, and keeping both current against the watch stream. The
   component above it (`components/workspace/file-explorer.tsx`) is left with
   what a person does — open, rename, create, delete, filter — and what that
   looks like.

   Two decisions shape this, and they are the file:

   **Listings are cached per directory, not as a tree.** The state is
   `Map<dirPath, entries>` plus a set of expanded paths, and the rendered tree
   is derived from the two (`lib/ide/tree-rows.ts`). That is what lets a watch
   event invalidate exactly the directory that changed and leave every other
   branch — including its expansion and its scroll position — untouched. A
   nested tree object would have to be rebuilt from the root, which is the
   version of this that collapses everything you had open every time a build
   writes a file.

   **The server is the authority on what exists.** Nothing here optimistically
   inserts a row: create, rename and delete re-read the affected directory. A
   tree that shows a file the server would refuse to open is worse than one
   that takes 20ms to catch up. */
import * as React from "react"

import { describeError } from "@/lib/errors"
import type { DirState } from "@/lib/ide/tree-rows"
import { dirname, listTree } from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

export interface FileTree {
  dirs: Map<string, DirState>
  expanded: Set<string>
  showHidden: boolean
  setShowHidden: React.Dispatch<React.SetStateAction<boolean>>
  /** Read one directory from the server. Stable. */
  load: (path: string) => Promise<void>
  /** Re-read every directory currently on screen. Stable. */
  refresh: () => void
  /** Expand or collapse. Stable. */
  toggle: (path: string) => void
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
}

export function useFileTree(projectId: string): FileTree {
  const [dirs, setDirs] = React.useState<Map<string, DirState>>(() => new Map())
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]))
  const [showHidden, setShowHidden] = React.useState(false)

  /* `load` has to be *stable*. Everything downstream keys off its identity: the
     watch subscription, which would otherwise tear down and re-open the server
     stream every time the dotfile toggle moves, and the on-demand effect, which
     would re-run and duplicate every in-flight request. So the toggle lives in
     a ref that `load` reads, and changing it triggers exactly one refresh. */
  const showHiddenRef = React.useRef(showHidden)
  showHiddenRef.current = showHidden

  /* Staleness is tracked per directory, not globally. A single counter is
     wrong here: expanding four folders at once bumps it four times, so the
     first answer back looks stale against a generation that a *different*
     directory advanced. Each path only races itself. */
  const inflight = React.useRef(new Map<string, number>())
  const load = React.useCallback(
    async (path: string) => {
      const mine = (inflight.current.get(path) ?? 0) + 1
      inflight.current.set(path, mine)
      setDirs((current) => {
        const next = new Map(current)
        next.set(path, { ...(next.get(path) ?? { entries: [], truncated: false }), loading: true })
        return next
      })
      try {
        const listing = await listTree(projectId, path, { hidden: showHiddenRef.current })
        if (inflight.current.get(path) !== mine) return
        setDirs((current) => {
          const next = new Map(current)
          next.set(path, { entries: listing.entries, truncated: listing.truncated, loading: false })
          return next
        })
      } catch (err) {
        if (inflight.current.get(path) !== mine) return
        const { title, detail } = describeError(err)
        setDirs((current) => {
          const next = new Map(current)
          next.set(path, {
            entries: [],
            truncated: false,
            loading: false,
            error: detail ? `${title} — ${detail}` : title,
          })
          return next
        })
      }
    },
    [projectId]
  )

  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded
  const refresh = React.useCallback(() => {
    for (const path of [...expandedRef.current]) void load(path)
  }, [load])

  /* Anything expanded and not yet read, loads. Collapsing keeps the listing
     cached, so re-expanding is instant and only a refresh goes back to disk. */
  const dirsRef = React.useRef(dirs)
  dirsRef.current = dirs
  React.useEffect(() => {
    for (const path of expanded) if (!dirsRef.current.has(path)) void load(path)
  }, [expanded, load])

  const hiddenFirstRun = React.useRef(true)
  React.useEffect(() => {
    /* The toggle re-reads what is open rather than clearing it: the tree you
       were looking at should still be the tree you are looking at. */
    if (hiddenFirstRun.current) {
      hiddenFirstRun.current = false
      return
    }
    refresh()
  }, [showHidden, refresh])

  /* Watch events name a path; what they invalidate is the directory that holds
     it. An overflow names nothing, so everything open is re-read — which is
     what "I stopped counting" has to mean. */
  React.useEffect(
    () =>
      watchProject(projectId, (batch) => {
        if (batch.overflow) {
          setExpanded((open) => {
            for (const path of open) void load(path)
            return open
          })
          return
        }
        const touched = new Set<string>()
        for (const event of batch.events) touched.add(dirname(event.path))
        setExpanded((open) => {
          for (const dir of touched) if (open.has(dir)) void load(dir)
          return open
        })
      }),
    [projectId, load]
  )

  const toggle = React.useCallback(
    (path: string) =>
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      }),
    []
  )

  return { dirs, expanded, showHidden, setShowHidden, load, refresh, toggle, setExpanded }
}

/* ── The explorer's tree, flattened ──
   The rendered tree is derived from `Map<dirPath, entries>` plus a set of
   expanded paths (`components/workspace/file-explorer.tsx` says why the cache
   is per directory and not a nested object). This module is the derivation, and
   it is pure so that it can be *memoized*.

   That is the whole point of it existing. The explorer used to build its JSX by
   recursing in the middle of `render`, which meant every expanded node was
   rebuilt on every keystroke in the filter box, on every watch event, and on
   every click that only moved the selection — each row allocating a fresh
   context-menu array of closures on the way past. Nothing downstream could be
   `React.memo`'d, because nothing downstream was ever handed the same value
   twice.

   So the tree becomes **data**: a flat array of rows, each carrying its own
   depth, computed from the four things that actually change its shape. What is
   deliberately *not* an input is which row is selected — selection changes on
   every click, and folding it in here would invalidate the memo the array
   exists to feed. A row draws itself selected by comparing its own path, which
   is a prop on one row and not a rebuild of all of them.

   Flat is also what windowing needs (`hooks/use-windowed-rows.ts`): a
   fixed-height row at a known index is a slice, and a tree is not. */
import type { WorkspaceEntry } from "@/lib/workspace/fs-api"

/** One directory's listing, as the explorer caches it. */
export interface DirState {
  entries: WorkspaceEntry[]
  truncated: boolean
  loading: boolean
  error?: string
}

/** An inline row being typed into: a new file/folder, or a rename. */
export interface Draft {
  kind: "create-file" | "create-dir" | "rename"
  /** The directory it lives in. */
  dir: string
  /** For a rename, the path being renamed. */
  target?: string
  value: string
}

/* Every row is one fixed-height line, which is what lets the list be windowed
   by arithmetic rather than by measurement — except the skeleton, which stands
   for a directory still being read and is deliberately several lines tall. Its
   height is declared here so the windowing maths and the CSS cannot disagree. */
export const ROW_HEIGHT = 28
export const SKELETON_ROWS = 4

export type TreeRow =
  /** A real entry: a file or a directory. */
  | { kind: "entry"; key: string; depth: number; entry: WorkspaceEntry; expanded: boolean }
  /** The inline name field — a create, or a rename standing in for its entry. */
  | { kind: "draft"; key: string; depth: number }
  /** A directory that could not be read. */
  | { kind: "error"; key: string; depth: number; message: string }
  /** A directory being read for the first time. */
  | { kind: "loading"; key: string; depth: number }
  /** "Empty", "No matches", "… more, not shown". */
  | { kind: "note"; key: string; depth: number; text: string; title?: string }

/** How many fixed-height lines a row occupies. Only the skeleton is not one. */
export function rowLines(row: TreeRow): number {
  return row.kind === "loading" ? SKELETON_ROWS : 1
}

/**
 * Walk the expanded tree into a flat array, deepest-last, in draw order.
 *
 * `query` filters entry *names* within each directory the way the old renderer
 * did — it narrows what a listing shows, and deliberately does not search
 * unexpanded directories, which is `file-search.tsx`'s job and a different
 * round trip.
 */
export function flattenTree(input: {
  dirs: ReadonlyMap<string, DirState>
  expanded: ReadonlySet<string>
  /** Already trimmed and lower-cased by the caller. */
  query: string
  draft: Draft | null
}): TreeRow[] {
  const { dirs, expanded, query, draft } = input
  const rows: TreeRow[] = []

  const walk = (path: string, depth: number): void => {
    const dir = dirs.get(path)
    if (!dir) return

    /* A directory that refused to be read says so and stops: whatever is under
       it is unknown, not empty. */
    if (dir.error) {
      rows.push({ kind: "error", key: `${path}:error`, depth, message: dir.error })
      return
    }

    const entries = query
      ? dir.entries.filter((entry) => entry.name.toLowerCase().includes(query))
      : dir.entries

    for (const entry of entries) {
      const isOpen = expanded.has(entry.path)
      /* A rename replaces the row it renames rather than appearing beside it —
         there is one name, and it is being edited. */
      if (draft?.kind === "rename" && draft.target === entry.path) {
        rows.push({ kind: "draft", key: entry.path, depth })
      } else {
        rows.push({ kind: "entry", key: entry.path, depth, entry, expanded: isOpen })
      }
      if (entry.type === "dir" && isOpen) walk(entry.path, depth + 1)
    }

    /* A create lands at the end of the directory it was asked for, one level in
       from it — the row you are naming is inside the folder you clicked. */
    const creating = draft && draft.kind !== "rename" && draft.dir === path
    if (creating) rows.push({ kind: "draft", key: `${path}:draft`, depth })

    if (dir.loading && dir.entries.length === 0) {
      rows.push({ kind: "loading", key: `${path}:loading`, depth })
    } else if (!dir.loading && entries.length === 0 && !creating) {
      /* Scoped to *this* directory. The old test was `!draft`, so naming a file
         anywhere in the tree silently un-emptied every other empty folder on
         screen — one global flag answering a question that is per directory. */
      rows.push({
        kind: "note",
        key: `${path}:empty`,
        depth,
        text: query ? "No matches" : "Empty",
      })
    }

    if (dir.truncated) {
      rows.push({
        kind: "note",
        key: `${path}:truncated`,
        depth,
        text: "… more, not shown",
        title: "This directory has more entries than the server will list at once.",
      })
    }
  }

  walk("", 0)
  return rows
}

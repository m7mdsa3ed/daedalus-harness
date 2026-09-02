/**
 * Group a flat list of paths into a directory tree.
 *
 * Pure — no DOM, no server — so it is trivially unit-testable, and one function
 * feeds both surfaces that need it: the source-control view's working set and a
 * turn's changed files. It is generic in what a row *carries* because those two
 * carry different things (a `GitFileState` and a `ChangedFile`); what they share
 * is the only thing this file knows about, which is that a path has slashes in
 * it.
 *
 * **Single-child chains compact.** `src/lib/ide/monaco.ts` alone under `src`
 * draws as one row reading `src/lib/ide`, not three rows each holding one
 * child. Four levels of indentation to say nothing is exactly the shape that
 * makes a tree unreadable in a 320px column, and it is what a file explorer
 * does for the same reason. Compaction is opt-in (`compact`), because a tree
 * whose folders are *toggled* by the reader should keep the folder they
 * toggled.
 */

export interface PathFileNode<T> {
  kind: "file"
  /** The file's own name. */
  name: string
  /** Repo-relative path, POSIX. */
  path: string
  /** Whatever the caller was listing. */
  item: T
}

export interface PathDirNode<T> {
  kind: "dir"
  /** The segment, or the joined run of segments when compacted. */
  name: string
  /** Path of the directory, POSIX, no trailing slash. */
  path: string
  /** Child directories, sorted by name. */
  dirs: PathDirNode<T>[]
  /** Child files, sorted by name. */
  files: PathFileNode<T>[]
}

/** Total file count under a directory, for the count badge on a folder row. */
export function countFiles<T>(node: PathDirNode<T>): number {
  return node.files.length + node.dirs.reduce((sum, child) => sum + countFiles(child), 0)
}

/** Every file under a directory, in tree order — what a folder-level stage or
    discard acts on. */
export function filesUnder<T>(node: PathDirNode<T>): PathFileNode<T>[] {
  return [...node.dirs.flatMap(filesUnder), ...node.files]
}

/** Every directory path in a tree, for "expand all". */
export function directoryPaths<T>(node: PathDirNode<T>): string[] {
  return node.dirs.flatMap((dir) => [dir.path, ...directoryPaths(dir)])
}

const compareByName = (a: { name: string }, b: { name: string }) =>
  /* Case-insensitive, so `src/` sits above `tests/` regardless of case —
     matching how a file explorer reads rather than how ASCII sorts. */
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

export function buildPathTree<T>(
  items: T[],
  pathOf: (item: T) => string,
  options: { compact?: boolean } = {}
): PathDirNode<T> {
  const root: PathDirNode<T> = { kind: "dir", name: "", path: "", dirs: [], files: [] }
  const dirIndex = new Map<string, PathDirNode<T>>()
  dirIndex.set("", root)

  for (const item of items) {
    const path = pathOf(item)
    const parts = path.split("/")
    let node = root
    let prefix = ""
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const segment = parts[depth]
      prefix = prefix ? `${prefix}/${segment}` : segment
      let child = dirIndex.get(prefix)
      if (!child) {
        child = { kind: "dir", name: segment, path: prefix, dirs: [], files: [] }
        dirIndex.set(prefix, child)
        node.dirs.push(child)
      }
      node = child
    }
    node.files.push({ kind: "file", name: parts[parts.length - 1], path, item })
  }

  sortTree(root)
  if (options.compact) compactTree(root)
  return root
}

function sortTree<T>(node: PathDirNode<T>): void {
  node.dirs.sort(compareByName)
  node.files.sort(compareByName)
  for (const child of node.dirs) sortTree(child)
}

/** Fold `a` → `b` → `c` into one `a/b/c` row, depth-first so the deepest run
    collapses before its parent looks at it. The root is never folded: it is the
    repository, not a folder someone can open. */
function compactTree<T>(node: PathDirNode<T>): void {
  for (const child of node.dirs) compactTree(child)
  node.dirs = node.dirs.map(fold)
}

function fold<T>(dir: PathDirNode<T>): PathDirNode<T> {
  let current = dir
  let name = dir.name
  while (current.files.length === 0 && current.dirs.length === 1) {
    const only = current.dirs[0]
    name = `${name}/${only.name}`
    current = only
  }
  /* The folded node keeps the *deepest* path, so toggling it and acting on it
     both address the directory the reader can actually see. */
  return current === dir ? dir : { ...current, name }
}

/* ── The changed-files façade ──
   `ChangedFile` was what this file was written for and is still the common
   case, so it keeps a name of its own rather than making every caller spell out
   the accessor. */
import type { ChangedFile } from "@daedalus/protocol"

export type FileNode = PathFileNode<ChangedFile>
export type DirNode = PathDirNode<ChangedFile>

export function buildTree(files: ChangedFile[], options: { compact?: boolean } = {}): DirNode {
  return buildPathTree(files, (file) => file.path, options)
}

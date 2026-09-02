/**
 * Group a flat list of changed files into a directory tree for the source-control
 * panel. Pure — no DOM, no server — so it is trivially unit-testable and the same
 * function feeds a turn's scope or `uncommitted`. A file keeps its `ChangedFile`
 * payload on the node; a folder carries only its children, so a row in the UI is
 * either a file (with a status) or a directory (with a stash of files beneath it).
 */
import type { ChangedFile } from "@daedalus/protocol"

export interface FileNode {
  kind: "file"
  /** The file's own name. */
  name: string
  /** Repo-relative path, POSIX. */
  path: string
  /** The originating ChangedFile — status, counts, rename source. */
  file: ChangedFile
}

export interface DirNode {
  kind: "dir"
  name: string
  /** Path of the directory, POSIX, no trailing slash. */
  path: string
  /** Child directories, sorted by name. */
  dirs: DirNode[]
  /** Child files, sorted by name. */
  files: FileNode[]
}

/** Total file count under a directory, for the count badge on a collapsed row. */
export function countFiles(node: DirNode): number {
  return node.files.length + node.dirs.reduce((sum, child) => sum + countFiles(child), 0)
}

/**
 * Build a tree. Paths are split on `/`; an empty input yields a directory with no
 * children. Sorting is case-insensitive so `src/` sits above `tests/` regardless
 * of case, matching how a file explorer reads.
 */
export function buildTree(files: ChangedFile[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", path: "", dirs: [], files: [] }
  const dirIndex = new Map<string, DirNode>()
  dirIndex.set("", root)

  const compare = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

  for (const file of files) {
    const parts = file.path.split("/")
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
    node.files.push({ kind: "file", name: parts[parts.length - 1], path: file.path, file })
  }

  sortTree(root, compare)
  return root
}

function sortTree(node: DirNode, compare: (a: { name: string }, b: { name: string }) => number): void {
  node.dirs.sort(compare)
  node.files.sort(compare)
  for (const child of node.dirs) sortTree(child, compare)
}

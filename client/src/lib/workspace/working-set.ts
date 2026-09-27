/* ── The working set ──
   Git reports four lists — staged, unstaged, untracked, conflicted — and the
   panel used to draw four groups, one per list. That is faithful to the
   porcelain and wrong about the work: **a file is one file**, and a file that
   is staged *and* edited again since appeared twice, in two groups, with two
   sets of buttons, and no row anywhere saying that those two rows were the same
   path in two states.

   So this folds the four lists into one array, one entry per path, each
   carrying how much of it is staged:

   - `"yes"`   — in the index and identical on disk. A commit takes all of it.
   - `"partial"` — in the index *and* changed again since. A commit takes some
     of it, which is the state that most needs saying and was least sayable.
   - `"no"`    — changed or untracked, nothing staged.

   That is a checkbox, and a checkbox is what the list draws: ticking stages,
   unticking unstages, and the indeterminate state is a real third thing rather
   than the same file in two places.

   Conflicts stay marked but are not a separate list either — a conflicted file
   is a file in the working set that cannot be staged until it is resolved.

   Pure and memoizable, for the reason: the
   fold runs on every watch tick and must not be redone on every keystroke in
   the commit box. */
import type { FileLayout } from "@/lib/ide/prefs"
import type { GitFileState, GitStatus } from "@/lib/workspace/git-api"
import { buildPathTree, countFiles, filesUnder, type PathDirNode } from "@/lib/workspace/git-tree"

export type Staged = "yes" | "no" | "partial"

export interface WorkingFile {
  path: string
  /** Where it moved from, for a rename. */
  from?: string
  staged: Staged
  /** Single-letter status, as the rows have always drawn it. */
  mark: string
  conflicted: boolean
  /** Never tracked by git, so "discard" cannot revert it — only delete can. */
  untracked: boolean
}

/** The order the list is read in: what needs a decision, then what is ready,
    then what is not. Conflicts first because nothing else can proceed past
    them, and untracked last because it is the noisiest and least urgent. */
const RANK: Record<string, number> = { conflict: 0, partial: 1, staged: 2, changed: 3, untracked: 4 }
const MARK_OF: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "U",
  untracked: "?",
}
const markOf = (state: string): string => MARK_OF[state] ?? state

const rankOf = (file: WorkingFile): number =>
  file.conflicted
    ? RANK.conflict!
    : file.untracked
      ? RANK.untracked!
      : file.staged === "partial"
        ? RANK.partial!
        : file.staged === "yes"
          ? RANK.staged!
          : RANK.changed!

/**
 * One entry per path, across all four of git's lists.
 *
 * The mark shown is the one that describes the *work*, which is the worktree's
 * where there is one and the index's otherwise: a file added to the index and
 * then edited is still "added" as far as the reader is concerned, and showing
 * the index letter for a path with unstaged edits hid that they existed.
 */
export function workingSet(status: GitStatus): WorkingFile[] {
  /* Membership is read explicitly rather than merged as the lists are walked:
     "in the index" and "changed on disk" are two independent facts about one
     path, and folding them in sequence made the answer depend on which list
     happened to be visited last. */
  const inIndex = new Map(status.staged.map((file) => [file.path, file]))
  const onDisk = new Map(status.unstaged.map((file) => [file.path, file]))
  const conflicted = new Map(status.conflicted.map((file) => [file.path, file]))
  const untracked = new Map(status.untracked.map((file) => [file.path, file]))

  const paths = new Set([
    ...conflicted.keys(),
    ...inIndex.keys(),
    ...onDisk.keys(),
    ...untracked.keys(),
  ])

  const files: WorkingFile[] = []
  for (const path of paths) {
    const index = inIndex.get(path)
    const disk = onDisk.get(path)
    const source: GitFileState =
      conflicted.get(path) ?? disk ?? index ?? untracked.get(path)!
    /* A conflicted path is never "staged": git will not let it be committed
       until it is resolved, and a tick beside it would be a lie. */
    const isConflicted = conflicted.has(path)
    files.push({
      path,
      from: source.from,
      conflicted: isConflicted,
      untracked: untracked.has(path),
      staged: isConflicted ? "no" : index && disk ? "partial" : index ? "yes" : "no",
      /* The mark describes the *work*, so the worktree's letter wins where
         there is one: a file added to the index and edited again is still
         drawn as changed, rather than as the clean "A" the index remembers. */
      mark: isConflicted
        ? "U"
        : untracked.has(path)
          ? "?"
          : markOf(disk?.worktree ?? index?.index ?? "modified"),
    })
  }

  return files.sort((a, b) => {
    const rank = rankOf(a) - rankOf(b)
    return rank !== 0 ? rank : a.path.localeCompare(b.path)
  })
}

/** What the commit button and the header count are about. */
export function countsOf(files: readonly WorkingFile[]): {
  total: number
  /** Anything a commit would take — fully or partly staged. */
  staged: number
  /** Anything with work not in the index yet. */
  unstaged: number
  conflicted: number
} {
  let staged = 0
  let unstaged = 0
  let conflicted = 0
  for (const file of files) {
    if (file.conflicted) conflicted++
    if (file.staged !== "no") staged++
    if (file.staged !== "yes") unstaged++
  }
  return { total: files.length, staged, unstaged, conflicted }
}

/* ── Drawing it ──
   The list is flattened to rows before it is drawn: a flat array of fixed-height
   rows can be memoized and windowed, and a repository mid-rebase with two
   thousand changed paths is two thousand DOM nodes otherwise. */

/** Every row is one line of this height — see `hooks/use-windowed-rows.ts`. */
export const WORK_ROW_HEIGHT = 28
export const WORK_ROW_HEIGHT_COARSE = 44

export type WorkRow =
  | {
      kind: "dir"
      key: string
      depth: number
      path: string
      name: string
      count: number
      /** Everything under it, for the folder-level stage and discard. */
      paths: string[]
      /** The tick a folder wears is its children's answer, folded. */
      staged: Staged
    }
  | { kind: "file"; key: string; depth: number; file: WorkingFile }

/** Fold a set of children into the one tick their folder wears. */
function foldStaged(files: readonly WorkingFile[]): Staged {
  let yes = 0
  let no = 0
  for (const file of files) {
    if (file.staged === "partial") return "partial"
    if (file.staged === "yes") yes++
    else no++
    if (yes > 0 && no > 0) return "partial"
  }
  return no === 0 && yes > 0 ? "yes" : "no"
}

export function flattenWorkingSet(
  files: readonly WorkingFile[],
  options: { layout: FileLayout; collapsed: ReadonlySet<string> }
): WorkRow[] {
  const rows: WorkRow[] = []

  if (options.layout === "list") {
    for (const file of files) rows.push({ kind: "file", key: file.path, depth: 0, file })
    return rows
  }

  /* Single-child chains fold into one row (`src/lib/ide` rather than three
     rows holding one child each) — the reason the tree is readable in a 320px
     column at all. */
  const tree = buildPathTree([...files], (file) => file.path, { compact: true })

  const walk = (node: PathDirNode<WorkingFile>, depth: number): void => {
    for (const dir of node.dirs) {
      const under = filesUnder(dir).map((leaf) => leaf.item)
      rows.push({
        kind: "dir",
        key: `dir:${dir.path}`,
        depth,
        path: dir.path,
        name: dir.name,
        count: countFiles(dir),
        paths: under.map((file) => file.path),
        staged: foldStaged(under),
      })
      if (!options.collapsed.has(dir.path)) walk(dir, depth + 1)
    }
    for (const leaf of node.files) {
      rows.push({ kind: "file", key: leaf.path, depth, file: leaf.item })
    }
  }

  walk(tree, 0)
  return rows
}

/* ── The groups the list is drawn in ──
   VS Code's shape, chosen over the one list above for the panel: what is going
   into the commit and what is not, each under its own header, with the verb on
   the row (+ / −) rather than a tick. The cost the one-list model was written
   to avoid is accepted deliberately — a file staged and edited again is a row
   in each group, and each row opens its own half of the diff (HEAD ↔ index
   above, index ↔ disk below), which is what makes the two rows two different
   things rather than one file said twice. `workingSet` still answers the
   counts, where a path is one path. */

export type GroupId = "merge" | "staged" | "changes"

export interface WorkGroup {
  id: GroupId
  title: string
  files: WorkingFile[]
}

export function scmGroups(status: GitStatus): WorkGroup[] {
  const conflicted = new Set(status.conflicted.map((file) => file.path))
  const file = (
    source: GitFileState,
    staged: Staged,
    mark: string,
    flags: { untracked?: boolean; conflicted?: boolean } = {}
  ): WorkingFile => ({
    path: source.path,
    from: source.from,
    staged,
    mark,
    untracked: flags.untracked ?? false,
    conflicted: flags.conflicted ?? false,
  })
  const byPath = (a: WorkingFile, b: WorkingFile) => a.path.localeCompare(b.path)
  const groups: WorkGroup[] = [
    {
      id: "merge",
      title: "Merge Changes",
      files: status.conflicted.map((f) => file(f, "no", "U", { conflicted: true })).sort(byPath),
    },
    {
      id: "staged",
      title: "Staged Changes",
      files: status.staged
        .filter((f) => !conflicted.has(f.path))
        .map((f) => file(f, "yes", markOf(f.index || "modified")))
        .sort(byPath),
    },
    {
      id: "changes",
      title: "Changes",
      files: [
        ...status.unstaged.filter((f) => !conflicted.has(f.path)).map((f) => file(f, "no", markOf(f.worktree || "modified"))),
        ...status.untracked.map((f) => file(f, "no", "?", { untracked: true })),
      ].sort(byPath),
    },
  ]
  return groups.filter((group) => group.files.length > 0)
}

export type ScmRow =
  | { kind: "group"; key: string; group: GroupId; title: string; count: number; paths: string[]; untracked: boolean }
  | (WorkRow & { group: GroupId })

/** Every group's header, then its rows (tree or list), as one flat array — so
    the three groups are one windowed scroller, not three. A folder's collapse
    is keyed per group (`group:path`): the same folder can be open above and
    shut below. */
export function flattenGroups(
  groups: readonly WorkGroup[],
  options: { layout: FileLayout; collapsedDirs: ReadonlySet<string>; collapsedGroups: ReadonlySet<GroupId> }
): ScmRow[] {
  const rows: ScmRow[] = []
  for (const group of groups) {
    rows.push({
      kind: "group",
      key: `group:${group.id}`,
      group: group.id,
      title: group.title,
      count: group.files.length,
      paths: group.files.map((file) => file.path),
      untracked: group.files.every((file) => file.untracked),
    })
    if (options.collapsedGroups.has(group.id)) continue
    const prefix = `${group.id}:`
    const collapsed = new Set(
      [...options.collapsedDirs].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    )
    for (const row of flattenWorkingSet(group.files, { layout: options.layout, collapsed }))
      rows.push({ ...row, key: `${prefix}${row.key}`, group: group.id })
  }
  return rows
}

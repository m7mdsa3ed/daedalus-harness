/* Where a child runs, said against the project it runs in.

   A runtime that places a subagent somewhere (`subagent_update.cwd`, absolute)
   usually places it inside the project, where the absolute path is mostly the
   project's own prefix said again. The row and the graph node say the part that
   is news — `src/api`, or `.` for the project root itself — and the whole path
   only for a directory outside it. Pure, so the graph check can walk it. */

/** Trailing slashes aside, two spellings of one directory are one place. */
const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

/** `cwd` relative to `root` when it is under it (`.` when equal), else as
    given. Without a root there is nothing to be relative to. */
export function relativeCwd(cwd: string, root: string | null | undefined): string {
  const child = trim(cwd)
  if (!root) return child
  const base = trim(root)
  if (child === base) return "."
  if (child.startsWith(base.endsWith("/") ? base : `${base}/`)) return child.slice(base.length).replace(/^\/+/, "")
  return child
}

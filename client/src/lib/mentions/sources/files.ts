/* Files and directories, anywhere on the machine: the query names its own
   scope and the server completes the path as typed (`searchEntries`,
   docs/client.md "`@` mentions"). A directory pick completes to `@path/` and
   leaves the token open so the next keystroke drills in; a file completes to
   `@path ` and is done. */
import { FileText, Folder } from "lucide-react"
import { formatBytes } from "@/lib/attachments"
import { searchFiles, type WorkspaceEntry } from "@/lib/workspace/fs-api"
import type { MentionSource } from "../types"

const LIMIT = 20

export const filesSource: MentionSource<WorkspaceEntry> = {
  id: "file",
  /* Wait after the last keystroke before asking the server. Long enough that
     typing a path costs one walk rather than one per character, short enough
     that it reads as instant. */
  debounceMs: 110,
  errorLabel: "Couldn't search for files",
  available: (ctx) => !!ctx.projectId,
  async search(query, ctx, _data, signal) {
    const result = await searchFiles(ctx.projectId!, query, { limit: LIMIT, signal })
    return result.entries
  },
  key: (entry) => entry.path,
  insert: (entry) =>
    entry.type === "dir"
      ? { type: "text", text: `@${entry.path}/`, open: true }
      : { type: "text", text: `@${entry.path}`, open: false },
  face: () => null,
  /* The directory is what tells two same-named files apart. It leads the row,
     dimmed — a row then reads as the path it will insert, and the list is one
     line per file instead of two. It is also what gives up width first, so the
     *name* survives a narrow composer. */
  row: (entry) => ({
    icon: entry.type === "dir" ? Folder : FileText,
    prefix: entry.path.slice(0, entry.path.length - entry.name.length) || undefined,
    label: entry.name,
    /* Size is the cheapest way to tell a 40-byte stub from the 2 MB bundle
       beside it, and the search already answered it. */
    aside: entry.type === "file" && entry.size !== undefined ? formatBytes(entry.size) : undefined,
    /* What the project's own tooling thinks of this path — an ignored or
       symlinked file is one you usually did not mean to name. */
    badge: entry.link ? "link" : entry.ignored ? "ignored" : entry.hidden ? "hidden" : undefined,
  }),
}

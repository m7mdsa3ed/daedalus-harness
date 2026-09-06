/* ── Finding a file ──
   Fuzzy path search across the project, over the route the composer's `@` menu
   already reads (`GET /api/projects/:id/files/search`). One route, one ranking,
   one idea of what "roughly this name" means — a second matcher in the client
   would answer differently from the one people type `@` into.

   Searching is *the destination's* own query, debounced and abortable, the same
   shape ⌘K's search page uses. An empty query is the project root's listing,
   which is what the route answers, so the view is never blank on open.

   This is deliberately file *names*, not file contents: the server has no grep
   route, and a client-side one would mean reading the project through the file
   API to search it. Naming that limit is better than a search box that quietly
   misses every match inside a file. */
import * as React from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { basename, searchFiles, type WorkspaceEntry } from "@/lib/workspace/fs-api"

const DEBOUNCE_MS = 160

export function FileSearch({
  projectId,
  onOpenFile,
}: {
  projectId: string
  onOpenFile: (path: string) => void
}) {
  const [query, setQuery] = React.useState("")
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      searchFiles(projectId, query, { limit: 200, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          setEntries(result.entries.filter((entry) => entry.type === "file"))
          setTruncated(result.truncated)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(describeError(err).title)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, query ? DEBOUNCE_MS : 0)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a file by name"
            aria-label="Find a file by name"
            className="h-7 ps-6 pe-6 text-xs"
          />
          {query && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear the search"
              className="absolute top-1/2 right-1 size-5 -translate-y-1/2"
              onClick={() => setQuery("")}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
      </PanelToolbar>

      {error && <PanelNotice className="text-destructive">{error}</PanelNotice>}
      {truncated && <PanelNotice>More matched than are shown. Type more of the name.</PanelNotice>}

      {entries.length === 0 ? (
        <PanelEmptyState>
          {loading ? "Searching…" : query ? "Nothing matches that name." : "This project has no files."}
        </PanelEmptyState>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1">
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => onOpenFile(entry.path)}
                title={entry.path}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <span className="shrink-0 truncate text-foreground">{basename(entry.path)}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] opacity-70">{entry.path}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

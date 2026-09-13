/* ── Finding a file ──
   Two questions, one box: *where is the file called roughly this* and *where is
   this written*. The first is the route the composer's `@` menu already reads
   (`GET /api/projects/:id/files/search`), so there is one ranking and one idea
   of what "roughly this name" means; the second is `/files/grep`, which reads
   bytes.

   Searching is *the destination's* own query, debounced and abortable, the same
   shape ⌘K's search page uses. An empty query is the project root's listing,
   which is what the name route answers, so the view is never blank on open.

   The name route is scope-aware (`~/`, absolute, relative) because the `@` menu
   can point an agent anywhere; this panel can only *open* files inside the
   project, so a hit outside it is dropped rather than offered and failed. The
   content route never leaves the project at all. */
import * as React from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import {
  basename,
  grepFiles,
  isProjectRelative,
  searchFiles,
  type WorkspaceContentMatch,
  type WorkspaceEntry,
} from "@/lib/workspace/fs-api"

const DEBOUNCE_MS = 160

type Mode = "name" | "content"

export function FileSearch({
  projectId,
  onOpenFile,
}: {
  projectId: string
  onOpenFile: (path: string, line?: number) => void
}) {
  const [query, setQuery] = React.useState("")
  const [mode, setMode] = React.useState<Mode>("name")
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([])
  const [matches, setMatches] = React.useState<WorkspaceContentMatch[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      const done = (result: { truncated: boolean }) => {
        if (controller.signal.aborted) return
        setTruncated(result.truncated)
        setError(null)
      }
      const failed = (err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      }
      if (mode === "content") {
        grepFiles(projectId, query, { limit: 200, signal: controller.signal })
          .then((result) => {
            if (controller.signal.aborted) return
            setMatches(result.matches)
            done(result)
          })
          .catch(failed)
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
        return
      }
      searchFiles(projectId, query, { limit: 200, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          /* The route is scope-aware since the `@` menu can search the whole
             machine; this panel can only open files inside the project, so a
             `~/` or absolute hit is dropped rather than offered and failed. */
          setEntries(result.entries.filter((entry) => entry.type === "file" && isProjectRelative(entry.path)))
          done(result)
        })
        .catch(failed)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, query ? DEBOUNCE_MS : 0)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, query, mode])

  /* Switching modes re-reads: the two routes answer different questions, and a
     list of names is not a stale answer to "where is this written". */
  const swapMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setLoading(true)
  }

  const count = mode === "content" ? matches.length : entries.length
  const nothing = count === 0 && !loading

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
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder={mode === "content" ? "Find in files" : "Find a file by name"}
            aria-label={mode === "content" ? "Find in files" : "Find a file by name"}
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
        {/* The mode is the same affordance as the composer's `Aa` toggle: one
            button that says which question the box is asking. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant={mode === "content" ? "secondary" : "ghost"}
                aria-label="Match file contents"
                aria-pressed={mode === "content"}
                className="size-6 shrink-0"
                onClick={() => swapMode(mode === "content" ? "name" : "content")}
              >
                <span className="text-[10px] font-semibold">Aa</span>
              </Button>
            }
          />
          <TooltipContent>
            {mode === "content" ? "Matching file contents" : "Match file contents too"}
          </TooltipContent>
        </Tooltip>
      </PanelToolbar>

      {error && (
        <div className="px-2 py-1.5">
          <Notice
            tone="error"
            action={
              <CopyButton
                text={error}
                size="icon-xs"
                className="shrink-0 text-destructive/70 hover:bg-destructive/15 hover:text-destructive"
              />
            }
          >
            {error}
          </Notice>
        </div>
      )}
      {truncated && (
        <div className="px-2 py-1.5">
          <Notice>
            {mode === "content"
              ? "More lines matched than are shown. Type more of the term."
              : "More matched than are shown. Type more of the name."}
          </Notice>
        </div>
      )}

      {/* In content mode an empty box is not an empty project — the route reads
          nothing until it has a term, so there is nothing to say yet. */}
      {mode === "content" && !query.trim() ? (
        <div className="p-2">
          <Empty>Type a term to search the contents of this project.</Empty>
        </div>
      ) : nothing ? (
        <div className="p-2">
          <Empty>
            {query
              ? mode === "content"
                ? "Nothing contains that."
                : "Nothing matches that name."
              : "This project has no files."}
          </Empty>
        </div>
      ) : loading && count === 0 ? (
        <PanelRowsSkeleton rows={8} split />
      ) : mode === "content" ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1">
            {matches.map((match) => (
              <button
                key={`${match.path}:${match.line}`}
                type="button"
                onClick={() => onOpenFile(match.path, match.line)}
                title={`${match.path}:${match.line}`}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent/50"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 truncate text-foreground">{basename(match.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] opacity-70">
                    {match.path}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-70">
                    :{match.line}
                  </span>
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {match.text.trim()}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
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

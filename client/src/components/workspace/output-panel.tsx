/* ── Output ──
   One buffer, two views. "Problems" is the records that parsed into a
   location — not a second panel with its own cap, its own search box and its
   own clear button. Which means a compiler's raw output and its diagnostics
   cannot disagree, because they are the same lines read two ways. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { SearchIcon, Trash2Icon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useDock } from "@/components/workspace/dock"
import { PanelEmptyState, PanelToolbar } from "@/components/workspace/primitives"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { clearOutput, sourcesIn, useOutput, type OutputRecord } from "@/lib/workspace/output"
import { markReveal } from "@/lib/workspace/reveal"

type View = "output" | "problems"

const SEVERITY_TONE = {
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
} as const

export function OutputPanel({ api, params }: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = params
  const dock = useDock()
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)
  const records = useOutput(projectId)

  const [view, setView] = React.useState<View>("output")
  const [query, setQuery] = React.useState("")
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set())
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = React.useState(true)

  const sources = React.useMemo(() => sourcesIn(records), [records])
  const problems = React.useMemo(() => records.filter((record) => record.location), [records])

  React.useEffect(() => {
    const count = problems.length
    api.setTitle(count > 0 ? `Output (${count})` : "Output")
  }, [api, problems.length])

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const pool = view === "problems" ? problems : records
    return pool.filter(
      (record) =>
        !hidden.has(record.source) &&
        (!needle || record.message.toLowerCase().includes(needle))
    )
  }, [records, problems, view, query, hidden])

  /* Follow the tail only while the user is already at the bottom. Yanking the
     scroll back down while somebody is reading an error further up is the
     single most annoying thing a log pane can do. */
  React.useEffect(() => {
    if (!pinned) return
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [visible.length, pinned])

  const open = (record: OutputRecord) => {
    if (!record.location) return
    const { relativePath, line, column } = record.location
    markReveal(projectId, relativePath, line, column)
    dock.openPanel({ kind: "editor", projectId, path: relativePath })
  }

  if (!project) {
    return (
      <PanelEmptyState>
        This project no longer exists.
      </PanelEmptyState>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <div className="flex shrink-0 items-center gap-0.5">
          {(["output", "problems"] as const).map((id) => (
            <Button
              key={id}
              size="xs"
              variant="ghost"
              className={cn("capitalize", view === id && "bg-muted text-foreground")}
              onClick={() => setView(id)}
            >
              {id}
              {id === "problems" && problems.length > 0 && (
                <span className="ml-1 text-[10px] opacity-70">{problems.length}</span>
              )}
            </Button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            aria-label="Filter output"
            className="h-7 ps-6 pe-6 text-xs"
          />
          {query && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear filter"
              className="absolute top-1/2 right-1 size-5 -translate-y-1/2"
              onClick={() => setQuery("")}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>

        {sources.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="xs" variant="ghost" className="shrink-0">
                  Sources
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {sources.map((source) => (
                <DropdownMenuCheckboxItem
                  key={source}
                  checked={!hidden.has(source)}
                  onCheckedChange={(checked) =>
                    setHidden((current) => {
                      const next = new Set(current)
                      if (checked) next.delete(source)
                      else next.add(source)
                      return next
                    })
                  }
                >
                  {source}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Clear output"
          title="Clear output"
          className="size-6"
          onClick={() => clearOutput(projectId)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </PanelToolbar>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-relaxed"
        onScroll={(event) => {
          const element = event.currentTarget
          setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 24)
        }}
      >
        {visible.length === 0 ? (
          <p className="p-4 text-center font-sans text-xs text-muted-foreground">
            {records.length === 0
              ? "Nothing yet. Agent errors and background task output land here."
              : "No lines match."}
          </p>
        ) : (
          visible.map((record) => (
            <Row key={record.id} record={record} onOpen={() => open(record)} />
          ))
        )}
      </div>
    </div>
  )
}

function Row({ record, onOpen }: { record: OutputRecord; onOpen: () => void }) {
  const location = record.location
  const body = (
    <>
      <span className="w-16 shrink-0 truncate text-[10px] text-muted-foreground/60">
        {record.source}
      </span>
      {location && (
        <span className={cn("shrink-0 text-[10px]", SEVERITY_TONE[location.severity])}>
          {location.relativePath}:{location.line}
        </span>
      )}
      <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{record.message}</span>
    </>
  )

  /* A row with a location is a button; one without is not. A log line that
     looks clickable and does nothing is worse than one that plainly is not. */
  return location ? (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-baseline gap-2 px-2 py-0.5 text-left hover:bg-muted/60"
    >
      {body}
    </button>
  ) : (
    <div className="flex items-baseline gap-2 px-2 py-0.5">{body}</div>
  )
}

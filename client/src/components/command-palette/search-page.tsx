/* ── Search ──
   The one page that asks the server, and the reason the root page no longer
   does. Two kinds of answer, on two clocks:

     - Threads: titles, matched here, instantly, from the store the sidebar
       already renders. They appear on the keystroke.
     - Messages: the transcripts, which live in SQLite behind an FTS5 index —
       one debounced request, the previous one aborted so a slow answer cannot
       overwrite a newer one.

   Splitting them is the whole point of this page existing. On the root list the
   two were one group of results interleaved with every command, so the fast
   half was held back by the slow half and both were ranked against "Toggle the
   sidebar". Here the slow half can take its time under its own heading, saying
   so, while the fast half is already on screen — and the root list is a pure
   local filter again.

   Results are drawn in the order they are given (`always: true`): the threads
   by our own score, the messages by the server's. */
import * as React from "react"
import { Loader2, MessageSquarePlusIcon, SearchXIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { CommandGroup, CommandSeparator } from "@/components/ui/command"
import { useSidebar } from "@/components/ui/sidebar"
import { KEYS } from "@/lib/shortcuts"
import { searchThreads, type SearchResult } from "@/lib/search"
import { activityAt, isTopLevel } from "@/lib/settings"
import { threadPath } from "@/lib/router"
import { useLiveTurnActive, useStoreSelect } from "@/lib/store"
import { usePalette } from "./context"
import { Row, type PaletteItem } from "./list"
import { messageItem, threadItem } from "./rows"
import { score } from "./score"

/** The server's index needs something to work with; one letter matches half a
    database and is not worth the round trip. */
const MIN_QUERY = 2
const DEBOUNCE_MS = 200
const THREAD_LIMIT = 12
const RECENT_LIMIT = 8

export function SearchPage() {
  const palette = usePalette()
  const sessions = useStoreSelect((store) => store.sessions)
  const projects = useStoreSelect((store) => store.projects)
  /* One boolean per row, off a map whose identity only moves when a turn
     starts or stops — subscribing to `threads` here redrew the palette on
     every token of every thread. */
  const liveTurnActive = useLiveTurnActive()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()
  const query = palette.query.trim()

  const [hits, setHits] = React.useState<SearchResult[]>([])
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (query.length < MIN_QUERY) {
      setHits([])
      setLoading(false)
      setFailed(false)
      return
    }
    setLoading(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchThreads(query, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return
          setHits(results)
          setFailed(false)
          setLoading(false)
        })
        .catch(() => {
          // Aborted, offline, or a server without the route. A search box that
          // toasts while you type is noise — the threads above still work.
          if (controller.signal.aborted) return
          setHits([])
          setFailed(true)
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const open = (sessionId: string) =>
    palette.run(() => {
      setOpenMobile(false)
      void navigate(threadPath(sessionId))
    })

  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? "Other"

  /* Deleted threads live in the sidebar's Trash, not here — searching is for
     going somewhere, and a deleted thread is nowhere to go. */
  const threads = React.useMemo(() => {
    const live = sessions.filter(isTopLevel).filter((session) => !session.deletedAt)
    if (!query) {
      return [...live].sort((a, b) => activityAt(b) - activityAt(a)).slice(0, RECENT_LIMIT)
    }
    return live
      .map((session) => ({
        session,
        s: score(`${session.title} ${projectName(session.projectId)}`, query),
      }))
      .filter((row) => row.s > 0)
      .sort((a, b) => b.s - a.s || activityAt(b.session) - activityAt(a.session))
      .slice(0, THREAD_LIMIT)
      .map((row) => row.session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, projects, query])

  const threadRows: PaletteItem[] = threads.map((session) =>
    threadItem({
      session,
      group: "Threads",
      project: projectName(session.projectId),
      running: liveTurnActive.get(session.id) ?? session.promptActive,
      onSelect: () => open(session.id),
      always: true,
    })
  )

  const messageRows = hits.map((hit) => messageItem(hit, () => open(hit.sessionId)))

  return (
    <>
      <CommandGroup heading={query ? "Threads" : "Recent threads"}>
        {threadRows.length > 0 ? (
          threadRows.map((item) => <Row key={item.id} item={item} />)
        ) : (
          <Note>No thread title matches “{query}”.</Note>
        )}
      </CommandGroup>

      <CommandGroup heading="Messages">
        {messageRows.map((item) => <Row key={item.id} item={item} />)}
        {/* The state of the request, always said in words: a group that is
            silently empty for 200ms reads as "nothing found", which is a
            different answer from "still asking". */}
        {messageRows.length === 0 &&
          (query.length < MIN_QUERY ? (
            <Note>Type {MIN_QUERY} characters or more to search inside transcripts.</Note>
          ) : loading ? (
            <Note>
              <Loader2 className="size-3.5 animate-spin" />
              Searching transcripts…
            </Note>
          ) : failed ? (
            <Note>
              <SearchXIcon className="size-3.5" />
              Couldn't reach the search index.
            </Note>
          ) : (
            <Note>No message matches “{query}”.</Note>
          ))}
        {/* Results are in, and a newer request is already out. */}
        {messageRows.length > 0 && loading && (
          <Note>
            <Loader2 className="size-3.5 animate-spin" />
            Updating…
          </Note>
        )}
      </CommandGroup>

      {query.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup>
            <Row
              item={{
                id: "search:ask",
                group: "",
                title: `Ask a new thread — “${query}”`,
                always: true,
                icon: <MessageSquarePlusIcon />,
                chord: KEYS.send,
                onSelect: () => palette.run(() => palette.newThread({ text: query })),
              }}
            />
          </CommandGroup>
        </>
      )}
    </>
  )
}

/** A line that says something about the list rather than being an entry in it —
    not a cmdk item, so ↑/↓ walk straight past it. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">{children}</div>
  )
}

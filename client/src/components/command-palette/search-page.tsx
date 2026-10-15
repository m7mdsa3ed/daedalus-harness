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

import { useSidebar } from "@/components/ui/sidebar"
import { KEYS } from "@/lib/shortcuts"
import { searchThreads, type SearchResult } from "@/lib/search"
import { useServer } from "@/lib/server-context"
import { activityAt, isListed } from "@/lib/settings"
import { useProjects } from "@/lib/queries/catalog"
import { currentThreadId, threadPath } from "@/lib/router"
import { requestComposerFocus } from "@/lib/composer-focus"
import { useThreadJump } from "@/components/right-panel/scope-dock"
import { useLiveTurnActive, useStoreSelect } from "@/lib/store"
import { useLocation } from "react-router"
import { usePalette } from "./context"
import { OrderedList, type PaletteGroup, type PaletteItem } from "./list"
import { messageItem, threadItem } from "./rows"
import { score } from "./score"

/** The server's index needs something to work with; one letter matches half a
    database and is not worth the round trip. */
const MIN_QUERY = 2
const DEBOUNCE_MS = 200
const THREAD_LIMIT = 12
const RECENT_LIMIT = 8

export function SearchPage({ threadScoped = false }: { threadScoped?: boolean }) {
  const palette = usePalette()
  const jumpRef = useThreadJump()
  const settings = useServer()
  const sessions = useStoreSelect((store) => store.sessions)
  const projects = useProjects()
  /* One boolean per row, off a map whose identity only moves when a turn
     starts or stops — subscribing to `threads` here redrew the palette on
     every token of every thread. */
  const liveTurnActive = useLiveTurnActive()
  const navigate = useNavigate()
  const location = useLocation()
  const { setOpenMobile } = useSidebar()
  const sessionId = threadScoped ? currentThreadId(location.pathname, location.search) : null
  const query = palette.query.trim()

  const [hits, setHits] = React.useState<SearchResult[]>([])
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if ((threadScoped && !sessionId) || query.length < MIN_QUERY) {
      setHits([])
      setLoading(false)
      setFailed(false)
      return
    }
    setLoading(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchThreads(settings, query, controller.signal, sessionId ?? undefined)
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
  }, [query, settings, sessionId])

  const open = (sessionId: string) =>
    palette.run(() => {
      setOpenMobile(false)
      requestComposerFocus(sessionId)
      void navigate(threadPath(sessionId))
    })

  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? "Other"

  /* Deleted threads live in the sidebar's Trash, not here — searching is for
     going somewhere, and a deleted thread is nowhere to go. */
  const threads = React.useMemo(() => {
    const live = sessions.filter(isListed).filter((session) => !session.deletedAt)
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
      project: projects.find((project) => project.id === session.projectId) ?? "Other",
      running: liveTurnActive.get(session.id) ?? session.promptActive,
      onSelect: () => open(session.id),
      always: true,
    })
  )

  const messageRows = hits.map((hit) =>
    messageItem(hit, () => {
      if (threadScoped && sessionId && hit.sessionId === sessionId && hit.turnId && hit.turnSeq !== null) {
        palette.run(() => {
          const jump = jumpRef?.current
          if (!jump) {
            void navigate(threadPath(sessionId))
            return
          }
          jump(undefined, { turnId: hit.turnId!, seq: hit.turnSeq! })
        })
      } else {
        open(hit.sessionId)
      }
    })
  )

  /* The state of the request, always said in words: a group that is silently
     empty for 200ms reads as "nothing found", which is a different answer from
     "still asking". */
  const messageNote = (): PaletteItem | null => {
    if (messageRows.length === 0) {
      if (threadScoped && !sessionId) return note("none", "This search is only available in a thread.")
      if (query.length < MIN_QUERY)
        return note("min", `Type ${MIN_QUERY} characters or more to search inside transcripts.`)
      if (loading)
        return note("loading", "Searching transcripts…", <Loader2 className="animate-spin" />)
      if (failed) return note("failed", "Couldn't reach the search index.", <SearchXIcon />)
      return note("none", `No message matches “${query}”.`)
    }
    // Results are in, and a newer request is already out.
    if (loading) return note("updating", "Updating…", <Loader2 className="animate-spin" />)
    return null
  }

  const messageTail = messageNote()

  const groups: PaletteGroup[] = threadScoped
    ? [
        {
          name: "Messages in this thread",
          items: messageTail ? [...messageRows, messageTail] : messageRows,
        },
      ]
    : [
        {
          name: query ? "Threads" : "Recent threads",
          items:
            threadRows.length > 0
              ? threadRows
              : [note("no-threads", `No thread title matches “${query}”.`)],
        },
        {
          name: "Messages",
          items: messageTail ? [...messageRows, messageTail] : messageRows,
        },
      ]

  if (query.length > 0 && !threadScoped) {
    groups.push({
      name: "",
      items: [
        {
          id: "search:ask",
          group: "",
          title: `Ask a new thread — “${query}”`,
          always: true,
          icon: <MessageSquarePlusIcon />,
          chord: KEYS.send,
          onSelect: () => palette.run(() => palette.newThread({ text: query })),
        },
      ],
    })
  }

  return <OrderedList groups={groups} />
}

/** A line that says something about the list rather than being an entry in it.
    It is a row — the menu counts its flat list, and anything not in it is
    skipped by the arrows and unreachable by the hover fill — but a disabled
    one, which is what ↑/↓ walk past. See `PaletteItem.note`. */
function note(id: string, title: string, icon?: React.ReactNode): PaletteItem {
  return { id: `search:note:${id}`, group: "", title, icon, note: true }
}

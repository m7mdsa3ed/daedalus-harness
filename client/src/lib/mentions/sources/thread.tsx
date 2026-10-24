/* `@thread:<id>` — another thread's transcript, as a recap the agent reads
   (`server/src/mentions/thread-recap.ts`). Picking one inserts `@thread:<id>`.

   The candidates are the threads the sidebar already holds (the store's
   `sessions`; drafts, workflow steps, trash and this thread excluded), matched
   on title — related threads first (this thread's forks and asides, and the one
   it was forked from), then by recency. From three characters the transcripts
   are searched too (`GET /api/search`, the palette's route) and the threads
   they hit are merged in behind the title matches. A `#turn-N` suffix (typed by
   hand) names one turn; the chip says so. */
import { MessagesSquare } from "lucide-react"
import * as React from "react"
import { AgentIcon } from "@/components/entity-icon"
import { useProjects } from "@/lib/queries/catalog"
import { searchThreads } from "@/lib/search"
import { useServer } from "@/lib/server-context"
import { activityAt, isListed, relativeAge, type Project, type ServerSettings, type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { defineKindSource } from "../kind"
import type { KindMatch } from "../types"

export interface ThreadMatch extends KindMatch {
  agentId: string
}

interface ThreadData {
  sessions: SessionMeta[]
  projects: Project[]
  settings: ServerSettings
}

const LIMIT = 8
/** Characters before transcripts are searched too (the palette's rule). */
const CONTENT_MIN = 3

/** The id a ref names: the part before a `#turn-N` suffix. */
const threadId = (ref: string) => ref.split("#")[0]
const turnOf = (ref: string) => /^turn-(\d+)$/.exec(ref.split("#")[1] ?? "")?.[1]
const shortId = (id: string) => id.slice(0, 8)
const titleOf = (session: Pick<SessionMeta, "id" | "title">) => session.title.trim() || `Thread ${shortId(session.id)}`

function match(session: SessionMeta, projects: Project[]): ThreadMatch {
  return {
    ref: session.id,
    label: titleOf(session),
    description: projects.find((p) => p.id === session.projectId)?.name,
    aside: relativeAge(activityAt(session)),
    agentId: session.agentId,
  }
}

/** Closer to the thread being typed in first: what it was forked from, then what
    was forked (or set aside) from it. */
function relatedRank(current: SessionMeta | undefined, session: SessionMeta): number {
  if (!current) return 2
  if (current.forkedFromSessionId === session.id) return 0
  if (session.forkedFromSessionId === current.id) return 1
  return 2
}

/** The chip's face from the store: the thread's own title and its agent's mark. */
function useThreadFace(ref: string | null) {
  const id = ref === null ? null : threadId(ref)
  const session = useStoreSelect((state) => (id ? state.sessions.find((s) => s.id === id) : undefined))
  if (ref === null || !session) return null
  const turn = turnOf(ref)
  return {
    icon: MessagesSquare,
    mark: <AgentIcon agentId={session.agentId} className="size-3.5 self-center" />,
    label: titleOf(session),
    aside: turn ? `turn ${turn}` : undefined,
  }
}

export const threadSource = defineKindSource<ThreadMatch, ThreadData>({
  kind: "thread",
  icon: MessagesSquare,
  hint: "Another thread's transcript",
  // Title matching is instant, but the transcript search is a request: one debounce for the source.
  debounceMs: 150,
  errorLabel: "Couldn't search threads",
  useData(_ctx, query) {
    const sessions = useStoreSelect((state) => state.sessions)
    const projects = useProjects()
    const settings = useServer()
    // `query` only gates the work in sources that fetch; this one reads state it is subscribed to anyway.
    void query
    return React.useMemo(() => ({ sessions, projects, settings }), [sessions, projects, settings])
  },
  available: (ctx) => !!ctx.projectId,
  async search(query, ctx, { sessions, projects, settings }, signal) {
    const q = query.trim().toLowerCase()
    const current = sessions.find((s) => s.id === ctx.sessionId)
    const pool = sessions.filter((s) => isListed(s) && !s.deletedAt && s.id !== ctx.sessionId)

    const titled = pool
      .filter((s) => !q || titleOf(s).toLowerCase().includes(q) || s.id.toLowerCase().startsWith(q))
      .sort((a, b) => relatedRank(current, a) - relatedRank(current, b) || activityAt(b) - activityAt(a))
      .map((s) => match(s, projects))

    if (q.length < CONTENT_MIN) return titled.slice(0, LIMIT)

    const seen = new Set(titled.map((m) => m.ref))
    const byId = new Map(pool.map((s) => [s.id, s]))
    const found = [...titled]
    try {
      for (const hit of await searchThreads(settings, query.trim(), signal)) {
        const session = byId.get(hit.sessionId)
        if (!session || seen.has(session.id)) continue
        seen.add(session.id)
        found.push(match(session, projects))
      }
    } catch (error) {
      // An aborted search is the caller's to drop; any other failure leaves the title matches, which are real.
      if (signal.aborted) throw error
    }
    return found.slice(0, LIMIT)
  },
  face: (ref) => ({ icon: MessagesSquare, label: shortId(threadId(ref)), aside: turnOf(ref) ? `turn ${turnOf(ref)}` : undefined }),
  useFace: useThreadFace,
  row: (m) => ({
    icon: MessagesSquare,
    mark: <AgentIcon agentId={m.agentId} className="size-4" />,
    label: m.label,
    description: m.description,
    aside: m.aside,
    badge: "thread",
  }),
})

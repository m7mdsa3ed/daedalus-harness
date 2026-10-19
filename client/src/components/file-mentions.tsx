import * as React from "react"
import type { TextSurface } from "@/components/composer/composer-editor"
import { AtSign, Boxes, FileText, Folder, Plug, SquareCheck } from "lucide-react"
import { reportError } from "@/lib/errors"
import { formatBytes } from "@/lib/attachments"
import { searchFiles, type WorkspaceEntry } from "@/lib/workspace/fs-api"
import { mcpNeedsAuth, mcpSubtitle, type McpServerDef, type ThreadMcpServer } from "@/lib/settings"
import { useMcpServers, useProjects } from "@/lib/queries/catalog"
import { useBoardsEnabled, useTasksQuery } from "@/lib/queries/boards"
import { taskKey } from "@/lib/tasks-board"
import { HARNESS_MCP_ID, TASK_MENTION_RE } from "@/lib/task-mentions"
import { McpIcon, ProjectIcon } from "@/components/entity-icon"
import { useStripSummary } from "./composer-strip"
import { CompleterList, CompleterNote, CompleterRow } from "./composer/completer"

/* `@` mentions for the composer — the file half of the slash menu.

   Same bargain as slash-commands: this is an *input affordance*, not a second
   prompt shape. What it completes is text (`@src/index.ts`), and the send path
   is untouched — the draft, the queue, the journal and the Retry row all stay
   strings. The protocol half is the server's: `AcpBridge.prompt` turns every
   mention that resolves to a real path into an ACP `resource_link` block beside
   the text (`server/src/mentions.ts`), so an agent that reads the protocol gets
   a reference and one that reads prose still gets the `@path` every runtime
   already understands.

   A query may name any path on the machine, not only the project: the scope is
   parsed server-side (`searchEntries` in `server/src/workspace-fs.ts`), so
   `@/etc/`, `@~/` and a relative `@src/` all search the directory they name, and
   the menu completes the path as typed. A directory pick appends `/` and leaves
   the token open so the next keystroke drills in; a file pick adds a space.

   Unlike a command, a mention can appear anywhere in the message — you name a
   file mid-sentence — so the token is read at the **caret**, not from the start
   of the text, and the caret is tracked rather than inferred. A thread with no
   project (which cannot happen today, but a draft is created before anything is
   guaranteed) simply never opens the menu — the project is the base a relative
   query resolves against, and the auth scope of the search route. */

/** Wait after the last keystroke before asking the server. Long enough that
    typing a path costs one walk rather than one per character, short enough
    that it reads as instant. */
const DEBOUNCE_MS = 110
const LIMIT = 20

/** A resource one of the thread's MCP servers offers. Picking one does not
    insert text: the token is removed and the resource is read and attached
    (`onResource`), because what it names is not a path the agent can open. */
export interface McpResourceMatch {
  type: "mcp-resource"
  serverId: string
  server: string
  uri: string
  name: string
  mimeType?: string
}

export interface McpServerMatch {
  type: "mcp-server"
  server: McpServerDef
}

/** Another project. Picking one inserts its cwd as an absolute `@path`, so it is
    an ordinary mention from there on — `mentions.ts` links any path that exists. */
export interface ProjectMatch {
  type: "project"
  id: string
  name: string
  cwd: string
  logoUrl?: string
}

/** A task from the board. Picking one inserts `@KEY-12`, which the send
    expands into the task and how to work it (`lib/task-mentions.ts`) — only for
    a thread that carries the Harness MCP, so only such a thread is offered one. */
export interface TaskMatch {
  type: "task"
  key: string
  title: string
  status?: string
}

export type MentionMatch = WorkspaceEntry | McpResourceMatch | McpServerMatch | ProjectMatch | TaskMatch


/** How many entries of each catalog join the file matches. */
const MCP_LIMIT = 8
const CATALOG_LIMIT = 8
/** Projects lead the list, so they are kept few enough not to bury the files. */
const PROJECT_LIMIT = 5

interface MentionToken {
  /** What has been typed after the `@`. */
  query: string
  /** Index of the `@` itself, so a pick can replace the whole token. */
  start: number
}

export interface FileMentionState {
  matches: MentionMatch[]
  selected: number
  /** A search is in flight and nothing is on screen for this query yet. */
  loading: boolean
  /** Non-null while the menu is open, even before results arrive. */
  query: string | null
  pick: (entry: MentionMatch) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
  /** Attach to the box: caret moves are what open and close the menu. */
  onSelect: () => void
  /** The message mentions a task but the thread has no Harness MCP, so the
      mention will go as plain text — said, rather than silently dropped. */
  taskWithoutHarness: boolean
  /** Where the caret must land once the *next* text change has rendered.
      Exported because this hook already owns the caret after every edit (see
      the effect below) — anything else that rewrites `text` and wants a caret
      placement has to go through the same slot, or the sync branch runs against
      the old selection and undoes it. The long-paste chip is the other caller. */
  requestCaret: (position: number) => void
}

export function useFileMentions(opts: {
  text: string
  setText: (text: string) => void
  projectId: string | undefined
  inputRef: React.RefObject<TextSurface | null>
  /** The thread's MCP servers, whose resources are offered after the files. */
  mcpServers?: ThreadMcpServer[]
  /** Draft-only MCP server choices; spawned threads cannot change their links. */
  draft?: boolean
  linkedMcpServerIds?: string[]
  onResource?: (resource: McpResourceMatch) => void
  onMcpServer?: (server: McpServerDef) => void
}): FileMentionState {
  const {
    text,
    setText,
    projectId,
    inputRef,
    mcpServers,
    draft = false,
    linkedMcpServerIds = [],
    onResource,
    onMcpServer,
  } = opts
  const libraryServers = useMcpServers()
  const linked = React.useMemo(() => new Set(linkedMcpServerIds), [linkedMcpServerIds])
  const [caret, setCaret] = React.useState(0)
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)
  const [fileMatches, setMatches] = React.useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  /* Results for queries already asked, so backspacing through a path does not
     re-walk the project. Dropped when the menu closes: a cache that outlives
     the mention would go on answering for files that have since moved. */
  const cache = React.useRef(new Map<string, WorkspaceEntry[]>())
  /** Where the caret must land once a pick has re-rendered the textarea. */
  const pendingCaret = React.useRef<number | null>(null)

  /* One effect owns the caret after every text change, and the pending case
     goes first: split in two, the sync branch would run against the *old*
     selection and undo the placement a pick just asked for. */
  React.useEffect(() => {
    const el = inputRef.current
    const pending = pendingCaret.current
    if (pending !== null) {
      pendingCaret.current = null
      el?.focus()
      el?.setSelectionRange(pending, pending)
      setCaret(pending)
      return
    }
    if (el) setCaret(el.selectionStart ?? text.length)
  }, [text, inputRef])

  // Escape closes the menu for this token only; typing anything reopens it.
  React.useEffect(() => setDismissed(false), [text])

  /* The token under the caret: `@` at a word boundary, then a run of non-space.
     The boundary is what keeps an email address from opening a file menu. */
  const token: MentionToken | null = React.useMemo(() => {
    if (dismissed) return null
    const match = /(?:^|[\s(])@([^\s@]*)$/.exec(text.slice(0, caret))
    if (!match) return null
    return { query: match[1], start: caret - match[1].length - 1 }
  }, [text, caret, dismissed])

  const query = token?.query ?? null
  const queryText = (query ?? "").toLowerCase()
  const serverMatches = React.useMemo((): McpServerMatch[] => {
    if (!draft || query === null || query.includes("/")) return []
    return libraryServers
      .filter((server) => !linked.has(server.id))
      .filter((server) => `${server.name} ${mcpSubtitle(server)}`.toLowerCase().includes(queryText))
      .slice(0, CATALOG_LIMIT)
      .map((server) => ({ type: "mcp-server", server }))
  }, [draft, libraryServers, linked, query, queryText])
  /* Tasks only where the agent can work them: the expansion tells it to call
     the Harness MCP, so without it there is nothing to mention. Asked for once
     the menu is open, never by a composer that is merely mounted. */
  const harness = linked.has(HARNESS_MCP_ID)
  const offerTasks = harness && query !== null && !query.includes("/")
  const tasksQuery = useTasksQuery(offerTasks)
  const { boards, statuses } = useBoardsEnabled(offerTasks)
  const taskMatches = React.useMemo((): TaskMatch[] => {
    if (!offerTasks) return []
    const keyOf = new Map(boards.map((b) => [b.id, b.key]))
    const statusOf = new Map(statuses.map((s) => [s.id, s.name]))
    return (tasksQuery.data ?? [])
      .filter((task) => !task.archived && keyOf.has(task.boardId))
      .map((task) => ({
        type: "task" as const,
        key: taskKey(task, keyOf.get(task.boardId)!),
        title: task.title,
        status: statusOf.get(task.statusId),
      }))
      .filter((task) => `${task.key} ${task.title}`.toLowerCase().includes(queryText))
      .slice(0, CATALOG_LIMIT)
  }, [offerTasks, boards, statuses, tasksQuery.data, queryText])
  const taskWithoutHarness = !harness && TASK_MENTION_RE.test(text)

  React.useEffect(() => {
    if (!projectId || query === null) {
      cache.current.clear()
      setMatches([])
      setLoading(false)
      return
    }
    const key = query.toLowerCase()
    const cached = cache.current.get(key)
    if (cached) {
      setMatches(cached)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      searchFiles(projectId, query, { limit: LIMIT, signal: controller.signal })
        .then((result) => {
          cache.current.set(key, result.entries)
          setMatches(result.entries)
          setLoading(false)
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          setMatches([])
          setLoading(false)
          /* A project whose directory has moved answers 404 for every query.
             Said once per keystroke would be a storm, so it is a toast on the
             request that actually failed and the menu simply stays empty. */
          reportError(err, "Couldn't search for files")
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, query])

  /* Filtered here rather than asked for: the listing is already in the cache,
     and a server's resource list is a handful of rows, not a tree to walk. */
  const resourceMatches = React.useMemo((): McpResourceMatch[] => {
    if (query === null || !mcpServers?.length) return []
    const q = query.toLowerCase()
    return mcpServers
      .flatMap((server) =>
        server.resources.map((r) => ({
          type: "mcp-resource" as const,
          serverId: server.id,
          server: server.name,
          uri: r.uri ?? r.name,
          name: r.description || r.uri || r.name,
          mimeType: r.mimeType,
        })),
      )
      .filter((r) => !q || `${r.server} ${r.name} ${r.uri}`.toLowerCase().includes(q))
      .slice(0, MCP_LIMIT)
  }, [query, mcpServers])
  /* A query with a `/` in it is a path being typed, never a project's name. */
  const projects = useProjects()
  const projectMatches = React.useMemo((): ProjectMatch[] => {
    if (query === null || query.includes("/")) return []
    const q = query.toLowerCase()
    return projects
      .filter((p) => p.id !== projectId && `${p.name} ${p.cwd}`.toLowerCase().includes(q))
      .slice(0, PROJECT_LIMIT)
      .map((p) => ({ type: "project" as const, id: p.id, name: p.name, cwd: p.cwd, logoUrl: p.logoUrl }))
  }, [query, projects, projectId])
  const matches = React.useMemo<MentionMatch[]>(
    () => [...taskMatches, ...serverMatches, ...projectMatches, ...fileMatches, ...resourceMatches],
    [taskMatches, serverMatches, projectMatches, fileMatches, resourceMatches],
  )

  // Clamp rather than reset, so narrowing the query keeps the highlight stable.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  const pick = (entry: MentionMatch) => {
    if (!token) return
    if (entry.type === "mcp-resource") {
      pendingCaret.current = token.start
      setText(text.slice(0, token.start) + text.slice(caret))
      setSelected(0)
      onResource?.(entry)
      return
    }
    if (entry.type === "mcp-server") {
      pendingCaret.current = token.start
      setText(text.slice(0, token.start) + text.slice(caret))
      setSelected(0)
      onMcpServer?.(entry.server)
      return
    }
    /* A directory completes to `@path/` and leaves the token open, so the next
       keystroke keeps drilling; a file or a project completes to `@path ` and is done. */
    const insert =
      entry.type === "project"
        ? `@${entry.cwd} `
        : entry.type === "task"
          ? `@${entry.key} `
          : `@${entry.path}${entry.type === "dir" ? "/" : " "}`
    pendingCaret.current = token.start + insert.length
    setText(text.slice(0, token.start) + insert + text.slice(caret))
    setSelected(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (token === null) return false
    switch (e.key) {
      case "ArrowDown":
        if (matches.length === 0) return false
        e.preventDefault()
        setSelected((index + 1) % matches.length)
        return true
      case "ArrowUp":
        if (matches.length === 0) return false
        e.preventDefault()
        setSelected((index - 1 + matches.length) % matches.length)
        return true
      case "Tab":
      case "Enter":
        if (matches.length === 0) return false
        // IME composition owns Enter (accepting a candidate, not a mention).
        if (e.nativeEvent.isComposing) return false
        e.preventDefault()
        pick(matches[index])
        return true
      case "Escape":
        e.preventDefault()
        setDismissed(true)
        return true
      default:
        return false
    }
  }

  const onSelect = () => setCaret(inputRef.current?.selectionStart ?? 0)

  const requestCaret = (position: number) => {
    pendingCaret.current = position
  }

  return {
    matches,
    selected: index,
    loading,
    query,
    pick,
    setSelected,
    onKeyDown,
    onSelect,
    taskWithoutHarness,
    requestCaret,
  }
}

/**
 * The matches, as a row on the composer strip — the same surface, and for the
 * same reasons, as `SlashCommandMenu`: it belongs to the text being typed right
 * now, so it stacks nearest the composer and pushes the box down instead of
 * painting over the plan or the queue.
 */
export function FileMentionMenu({ state }: { state: FileMentionState }) {
  const open = state.query !== null
  useStripSummary(
    open
      ? {
          id: "mention",
          icon: AtSign,
          label: state.loading && state.matches.length === 0
            ? "Searching files…"
            : state.matches.length === 0
              ? "No matches"
              : `${state.matches.length} match${state.matches.length === 1 ? "" : "es"}`,
          urgent: true,
        }
      : null
  )
  if (!open) {
    return state.taskWithoutHarness ? (
      <CompleterNote icon={SquareCheck}>
        Select the Harness MCP to mention tasks — this one will be sent as plain text.
      </CompleterNote>
    ) : null
  }

  /* Empty is a state worth drawing, not nothing: the summary line says the menu
     is up, and a row that vanishes while the query is still being typed reads
     as the feature breaking rather than as "no file is called that". */
  if (state.matches.length === 0) {
    return (
      <CompleterNote icon={AtSign}>
        {state.loading ? "Searching files…" : "No matches"}
      </CompleterNote>
    )
  }

  /* What the query is searching, said once at the foot rather than as a second
     line on every row: with the directory in front of each name the rows are
     already paths, and the scope is the one fact they all share. */
  const scope = state.query?.includes("/")
    ? state.query.slice(0, state.query.lastIndexOf("/") + 1)
    : undefined

  return (
    <CompleterList selected={state.selected} count={state.matches.length} hint={scope}>
      {state.matches.map((entry, i) => {
        if (entry.type === "task") {
          return (
            <CompleterRow
              key={`task:${entry.key}`}
              icon={SquareCheck}
              label={entry.key}
              description={entry.title}
              aside={entry.status}
              badge="task"
              selected={i === state.selected}
              onPick={() => state.pick(entry)}
              onHover={() => state.setSelected(i)}
            />
          )
        }
        if (entry.type === "mcp-server") {
          return (
            <CompleterRow
              key={`mcp-server:${entry.server.id}`}
              icon={Plug}
              mark={<McpIcon server={entry.server} className="size-3.5" />}
              label={entry.server.name}
              description={mcpSubtitle(entry.server)}
              badge={mcpNeedsAuth(entry.server) ? "needs auth" : "enable MCP"}
              selected={i === state.selected}
              onPick={() => state.pick(entry)}
              onHover={() => state.setSelected(i)}
            />
          )
        }
        if (entry.type === "mcp-resource") {
          return (
            <CompleterRow
              key={`mcp:${entry.serverId}:${entry.uri}`}
              icon={Plug}
              prefix={`${entry.server}: `}
              label={entry.name}
              aside={entry.mimeType}
              badge="MCP resource"
              selected={i === state.selected}
              onPick={() => state.pick(entry)}
              onHover={() => state.setSelected(i)}
            />
          )
        }
        if (entry.type === "project") {
          return (
            <CompleterRow
              key={`project:${entry.id}`}
              icon={Boxes}
              mark={<ProjectIcon project={entry} className="size-3.5" />}
              label={entry.name}
              aside={entry.cwd}
              badge="project"
              selected={i === state.selected}
              onPick={() => state.pick(entry)}
              onHover={() => state.setSelected(i)}
            />
          )
        }
        /* The directory is what tells two same-named files apart. It leads the
           row, dimmed — a row then reads as the path it will insert, and the
           list is one line per file instead of two. It is also what gives up
           width first, so the *name* survives a narrow composer. */
        const dir = entry.path.slice(0, entry.path.length - entry.name.length)
        return (
          <CompleterRow
            key={entry.path}
            icon={entry.type === "dir" ? Folder : FileText}
            prefix={dir || undefined}
            label={entry.name}
            /* Size is the cheapest way to tell a 40-byte stub from the 2 MB
               bundle beside it, and the search already answered it. Pinned to
               the row's end, where every row's is on one line. */
            aside={
              entry.type === "file" && entry.size !== undefined
                ? formatBytes(entry.size)
                : undefined
            }
            /* What the project's own tooling thinks of this path — an ignored
               or symlinked file is one you usually did not mean to name. */
            badge={
              entry.link ? "link" : entry.ignored ? "ignored" : entry.hidden ? "hidden" : undefined
            }
            selected={i === state.selected}
            onPick={() => state.pick(entry)}
            onHover={() => state.setSelected(i)}
          />
        )
      })}
    </CompleterList>
  )
}

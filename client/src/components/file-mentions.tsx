import * as React from "react"
import type { TextSurface } from "@/components/composer/composer-editor"
import { AtSign, SquareCheck } from "lucide-react"
import { reportError } from "@/lib/errors"
import type { McpServerDef, ThreadMcpServer } from "@/lib/settings"
import { HARNESS_MCP_ID, TASK_MENTION_RE } from "@/lib/task-mentions"
import { useFeature } from "@/lib/queries/surfaces"
import { MENTION_SOURCES, splitKindQuery } from "@/lib/mentions"
import { kindHintSource } from "@/lib/mentions/sources/kind-hint"
import type { AnyMentionSource, MentionCtx, MentionHit } from "@/lib/mentions"
import type { McpResourceMatch } from "@/lib/mentions/sources/mcp-resources"
import { useStripSummary } from "./composer-strip"
import { CompleterList, CompleterNote, CompleterRow } from "./composer/completer"

export type { McpResourceMatch }

/* `@` mentions for the composer — the file half of the slash menu.

   Same bargain as slash-commands: this is an *input affordance*, not a second
   prompt shape. What it completes is text (`@src/index.ts`), and the send path
   is untouched — the draft, the queue, the journal and the Retry row all stay
   strings. The protocol half is the server's: `AcpBridge.prompt` turns every
   mention that resolves to a real path into an ACP `resource_link` block beside
   the text (`server/src/mentions.ts`), so an agent that reads the protocol gets
   a reference and one that reads prose still gets the `@path` every runtime
   already understands.

   **This file knows no source.** What the menu offers — tasks, MCP servers,
   projects, files, MCP resources, and the `@kind:ref` kinds — is the registry
   in `lib/mentions/` (`MentionSource`); the hook asks each one for matches and
   the menu draws each one's row. It owns what is common to all of them: the
   token at the caret, the debounce and the cache of asynchronous searches, the
   key contract, and the caret after a pick.

   A query may name any path on the machine, not only the project: the scope is
   parsed server-side (`searchEntries` in `server/src/workspace-fs.ts`), so
   `@/etc/`, `@~/` and a relative `@src/` all search the directory they name, and
   the menu completes the path as typed. A directory pick appends `/` and leaves
   the token open so the next keystroke drills in; a file pick adds a space.

   A query that opens with a known `kind:` (two or more lowercase letters, then a
   colon — never `C:\`) is routed to that kind's source alone, and `@` or a
   prefix of a kind offers `kind:` hint rows whose pick leaves the token open.
   Both exist only when the server advertises `mentionKinds`.

   Unlike a command, a mention can appear anywhere in the message — you name a
   file mid-sentence — so the token is read at the **caret**, not from the start
   of the text, and the caret is tracked rather than inferred. A thread with no
   project (which cannot happen today, but a draft is created before anything is
   guaranteed) simply never opens the menu — the project is the base a relative
   query resolves against, and the auth scope of the search route. */

const NO_SIGNAL = new AbortController().signal

interface MentionToken {
  /** What has been typed after the `@`. */
  query: string
  /** Index of the `@` itself, so a pick can replace the whole token. */
  start: number
}

interface Entry {
  source: AnyMentionSource
  data: unknown
}

interface Route {
  /** The text typed after `@`, or null while the menu is closed. */
  query: string | null
  /** What the sources are asked: the query, or the part after a `kind:`. */
  q: string
  /** The sources in play, in registry order. */
  entries: Entry[]
  /** Kind hint rows to append — only on a plain query. */
  hints: Entry[]
}

export interface FileMentionState {
  matches: MentionHit[]
  selected: number
  /** A search is in flight and nothing is on screen for this query yet. */
  loading: boolean
  /** Non-null while the menu is open, even before results arrive. */
  query: string | null
  pick: (hit: MentionHit) => void
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
  /** The thread being typed in, for sources that read it. */
  sessionId?: string
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
    sessionId,
    inputRef,
    mcpServers,
    draft = false,
    linkedMcpServerIds = [],
    onResource,
    onMcpServer,
  } = opts
  const kinds = useFeature("mentionKinds")
  const linked = React.useMemo(() => new Set(linkedMcpServerIds), [linkedMcpServerIds])
  const [caret, setCaret] = React.useState(0)
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)
  /* Answers of the asynchronous sources, by source id. */
  const [results, setResults] = React.useState<Record<string, unknown[]>>({})
  const [loading, setLoading] = React.useState(false)
  /* Results for queries already asked, so backspacing through a path does not
     re-walk the project. Dropped when the menu closes: a cache that outlives
     the mention would go on answering for files that have since moved. */
  const cache = React.useRef(new Map<string, unknown[]>())
  /** Where the caret must land once a pick has re-rendered the textarea. */
  const pendingCaret = React.useRef<number | null>(null)
  /* A pick's side effects are the composer's latest closures; the context the
     sources see keeps one identity. */
  const actionsRef = React.useRef({ onResource, onMcpServer })
  actionsRef.current = { onResource, onMcpServer }
  const actions = React.useMemo<MentionCtx["actions"]>(
    () => ({
      onResource: (resource) => actionsRef.current.onResource?.(resource),
      onMcpServer: (server) => actionsRef.current.onMcpServer?.(server),
    }),
    [],
  )
  const harness = linked.has(HARNESS_MCP_ID)
  const ctx = React.useMemo<MentionCtx>(
    () => ({ projectId, sessionId, draft, linked, harness, mcpServers, kinds, actions }),
    [projectId, sessionId, draft, linked, harness, mcpServers, kinds, actions],
  )

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

  /* Every source's hook runs on every render, in registry order (a constant
     list, so the hook order is stable); each gates its own fetching on `query`. */
  const datas = MENTION_SOURCES.map((source) => source.useData?.(ctx, query))
  const all: Entry[] = MENTION_SOURCES.map((source, i) => ({ source, data: datas[i] }))

  /* Where the query goes. A known `kind:` prefix wins even over a later `/`
     (`@branch:feature/x`); otherwise it is a plain query for every source that
     is not a kind, and a prefix of a kind also draws that kind's hint row. */
  const route: Route = (() => {
    if (query === null) return { query, q: "", entries: [], hints: [] }
    const routed = kinds ? splitKindQuery(query) : null
    if (routed) {
      const only = all.find((e) => e.source.kind === routed.kind && e.source.available(ctx, e.data))
      if (only) return { query, q: routed.rest, entries: [only], hints: [] }
    }
    const entries = all.filter((e) => !e.source.kind && e.source.available(ctx, e.data))
    const hints =
      kinds && /^[a-z]*$/.test(query)
        ? all.filter((e) => e.source.kind?.startsWith(query) && e.source.available(ctx, e.data))
        : []
    return { query, q: query, entries, hints }
  })()
  /* The effect below is keyed on `asyncKey` alone (what actually changes the
     question), and reads the rest through refs: `ctx` gets a new identity
     whenever a caller passes a fresh array, and an effect that set state on
     each of those would re-ask forever. */
  const routeRef = React.useRef(route)
  routeRef.current = route
  const ctxRef = React.useRef(ctx)
  ctxRef.current = ctx
  const asyncIds = route.entries.filter((e) => e.source.debounceMs !== undefined).map((e) => e.source.id)
  const asyncKey = `${asyncIds.join(",")}\0${route.q}\0${projectId ?? ""}`

  React.useEffect(() => {
    const { query: asked, q, entries } = routeRef.current
    const live = entries.filter((e) => e.source.debounceMs !== undefined)
    if (asked === null || !projectId) cache.current.clear()
    if (asked === null || live.length === 0) {
      setResults({})
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timers: ReturnType<typeof setTimeout>[] = []
    let pending = 0
    for (const { source, data } of live) {
      const key = `${source.id}\0${q.toLowerCase()}`
      const cached = cache.current.get(key)
      if (cached) {
        setResults((prev) => ({ ...prev, [source.id]: cached }))
        continue
      }
      pending++
      timers.push(
        setTimeout(async () => {
          try {
            const found = await source.search(q, ctxRef.current, data, controller.signal)
            cache.current.set(key, found)
            setResults((prev) => ({ ...prev, [source.id]: found }))
          } catch (err) {
            if (controller.signal.aborted) return
            setResults((prev) => ({ ...prev, [source.id]: [] }))
            /* A project whose directory has moved answers 404 for every query.
               Said once per keystroke would be a storm, so it is a toast on the
               request that actually failed and the menu simply stays empty. */
            reportError(err, source.errorLabel ?? `Couldn't search ${source.id}`)
          } finally {
            if (!controller.signal.aborted && --pending === 0) setLoading(false)
          }
        }, source.debounceMs),
      )
    }
    setLoading(pending > 0)
    return () => {
      timers.forEach(clearTimeout)
      controller.abort()
    }
    // `route` and `ctx` are read through refs: `asyncKey` is what says it moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asyncKey])

  const matches = React.useMemo<MentionHit[]>(
    () => {
      const hits: MentionHit[] = []
      for (const { source, data } of route.entries) {
        const found =
          source.debounceMs !== undefined
            ? (results[source.id] ?? [])
            : (() => {
                const sync = source.search(route.q, ctx, data, NO_SIGNAL)
                return Array.isArray(sync) ? sync : []
              })()
        for (const match of found) hits.push({ key: `${source.id}:${source.key(match)}`, source, match })
      }
      for (const { source } of route.hints) {
        const match = { kind: source.kind!, icon: source.icon!, hint: source.hint ?? "" }
        hits.push({ key: `kind:${match.kind}`, source: kindHintSource as AnyMentionSource, match })
      }
      return hits
    },
    // The route is derived from exactly these; its entries carry fresh arrays every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, route.q, asyncKey, ctx, results, ...datas],
  )

  // Clamp rather than reset, so narrowing the query keeps the highlight stable.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  const pick = (hit: MentionHit) => {
    if (!token) return
    const insert = hit.source.insert(hit.match, ctx)
    if (insert.type === "remove") {
      pendingCaret.current = token.start
      setText(text.slice(0, token.start) + text.slice(caret))
      setSelected(0)
      insert.run()
      return
    }
    /* An open token (a directory's `/`, a kind hint's `:`) leaves the caret
       straight after it so the next keystroke keeps drilling; a finished one
       takes a space and is done. */
    const inserted = insert.open ? insert.text : `${insert.text} `
    pendingCaret.current = token.start + inserted.length
    setText(text.slice(0, token.start) + inserted + text.slice(caret))
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
    taskWithoutHarness: !harness && TASK_MENTION_RE.test(text),
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
      {state.matches.map((hit, i) => (
        <CompleterRow
          key={hit.key}
          {...hit.source.row(hit.match)}
          selected={i === state.selected}
          onPick={() => state.pick(hit)}
          onHover={() => state.setSelected(i)}
        />
      ))}
    </CompleterList>
  )
}

import * as React from "react"
import { AtSign, FileText, Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import { searchFiles, type WorkspaceEntry } from "@/lib/workspace/fs-api"
import { ComposerStripItem, useStripSummary } from "./composer-strip"

/* `@` mentions for the composer — the file half of the slash menu.

   Same bargain as slash-commands: this is an *input affordance*, not a second
   prompt shape. What it completes is text (`@src/index.ts`), and the send path
   is untouched — the draft, the queue, the journal and the Retry row all stay
   strings. The protocol half is the server's: `AcpBridge.prompt` turns every
   mention that resolves to a real path inside the cwd into an ACP
   `resource_link` block beside the text (`server/src/mentions.ts`), so an agent
   that reads the protocol gets a reference and one that reads prose still gets
   the `@path` every runtime already understands.

   Unlike a command, a mention can appear anywhere in the message — you name a
   file mid-sentence — so the token is read at the **caret**, not from the start
   of the text, and the caret is tracked rather than inferred. A thread with no
   project (which cannot happen today, but a draft is created before anything is
   guaranteed) simply never opens the menu. */

/** Wait after the last keystroke before asking the server. Long enough that
    typing a path costs one walk rather than one per character, short enough
    that it reads as instant. */
const DEBOUNCE_MS = 110
const LIMIT = 20

interface MentionToken {
  /** What has been typed after the `@`. */
  query: string
  /** Index of the `@` itself, so a pick can replace the whole token. */
  start: number
}

export interface FileMentionState {
  matches: WorkspaceEntry[]
  selected: number
  /** A search is in flight and nothing is on screen for this query yet. */
  loading: boolean
  /** Non-null while the menu is open, even before results arrive. */
  query: string | null
  pick: (entry: WorkspaceEntry) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
  /** Attach to the textarea: caret moves are what open and close the menu. */
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
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
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}): FileMentionState {
  const { text, setText, projectId, inputRef } = opts
  const [caret, setCaret] = React.useState(0)
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)
  const [matches, setMatches] = React.useState<WorkspaceEntry[]>([])
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
    if (!projectId || dismissed) return null
    const match = /(?:^|[\s(])@([^\s@]*)$/.exec(text.slice(0, caret))
    if (!match) return null
    return { query: match[1], start: caret - match[1].length - 1 }
  }, [text, caret, projectId, dismissed])

  const query = token?.query ?? null

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
          reportError(err, "Couldn't search the project's files")
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, query])

  // Clamp rather than reset, so narrowing the query keeps the highlight stable.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  const pick = (entry: WorkspaceEntry) => {
    if (!token) return
    /* A directory completes to `@path/` and leaves the token open, so the next
       keystroke keeps drilling; a file completes to `@path ` and is done. */
    const insert = `@${entry.path}${entry.type === "dir" ? "/" : " "}`
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

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
    setCaret(e.currentTarget.selectionStart ?? 0)

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
  const listRef = React.useRef<HTMLDivElement>(null)
  const open = state.query !== null
  useStripSummary(
    open
      ? {
          id: "mention",
          icon: AtSign,
          label: state.loading
            ? "Searching files…"
            : state.matches.length === 0
              ? "No matching files"
              : `${state.matches.length} file${state.matches.length === 1 ? "" : "s"}`,
          urgent: true,
        }
      : null
  )
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [state.selected, state.matches])

  if (!open) return null

  /* Empty is a state worth drawing, not nothing: the summary line says the menu
     is up, and a row that vanishes while the query is still being typed reads
     as the feature breaking rather than as "no file is called that". */
  if (state.matches.length === 0) {
    return (
      <ComposerStripItem className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
        <AtSign className="size-3 shrink-0" />
        <span>{state.loading ? "Searching files…" : "No matching files"}</span>
      </ComposerStripItem>
    )
  }

  return (
    <ComposerStripItem>
      {/* Caps at roughly five rows and scrolls — the same rule the command menu
          and the plan list follow. */}
      <div ref={listRef} className="max-h-44 overflow-y-auto p-1 overscroll-contain">
        {state.matches.map((entry, i) => {
          const dir = entry.path.slice(0, entry.path.length - entry.name.length)
          const Icon = entry.type === "dir" ? Folder : FileText
          return (
            <button
              key={entry.path}
              type="button"
              data-selected={i === state.selected || undefined}
              /* mousedown, not click: click fires after the textarea has lost
                 focus, and preventDefault here keeps the caret where typing
                 continues. */
              onMouseDown={(e) => {
                e.preventDefault()
                state.pick(entry)
              }}
              onMouseMove={() => state.setSelected(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left sm:py-1",
                i === state.selected && "bg-accent text-accent-foreground"
              )}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-xs">{entry.name}</span>
              {/* The directory is what tells two same-named files apart, so it
                  is the part that truncates, not the name. */}
              <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                {dir}
              </span>
            </button>
          )
        })}
      </div>
    </ComposerStripItem>
  )
}

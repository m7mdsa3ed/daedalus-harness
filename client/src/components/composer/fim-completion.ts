/* ── Ghost text from a fill-in-the-middle model ──
 *
 * The composer's one ambient call (`docs/plans/fim-composer.md`): after a pause,
 * the lane's completion model is asked to fill the gap at the caret and the
 * answer is drawn as ghost text — never written into `text`, because `text` is
 * the exact message sent. Tab puts it in as an ordinary edit (on a touch screen,
 * where there is no Tab, a tap on the ghost or the toolbar's button does); Escape drops it;
 * any keystroke retires it, since it was drawn for different text.
 *
 * Two shapes, one hook. A `!` line is a shell command: prefix-only, one line,
 * and only once the command name is finished (`!/name args` — a lone `!token`
 * belongs to the project menu, not here). Everything else is prose, where the
 * gap is what the caret sits in the middle of and a newline is a legitimate
 * answer.
 *
 * What it does *not* do: retry, toast, or hold the box. A suggestion is ambient,
 * so a failure is silence — a toast per pause would cost more than no ghost — and
 * the settings row (Settings › AI, Composer) is where a broken lane is diagnosed.
 */

import * as React from "react"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { useSideModel } from "@/lib/queries/side-models"

/** Long enough that a thinking pause is not a request, and no faster than
    Codestral's free tier allows (~one request a second). */
const DEBOUNCE_MS = 900

/** How much of each side one request carries. A completion needs the sentence,
    not the transcript. */
const MAX_PROMPT = 2_000
const MAX_SUFFIX = 500

const SHELL_MAX_TOKENS = 32
const PROSE_MAX_TOKENS = 48

/** A suggestion to draw: `text` at offset `at`. */
export interface FimGhost {
  at: number
  text: string
}

/** What one request carries, and how the answer is trimmed. */
interface Slice {
  prompt: string
  suffix?: string
  stop?: string[]
  maxTokens: number
  /** A `!` command: one line, and the gap is the rest of the command. */
  shell: boolean
}

/** The slice at a caret, or null when this is not a moment to ask. The thread's
    context is not composed here: it rides as its own field and the adapter puts
    it in front of the prompt (`server/src/fim.ts`), so it is written once. */
function sliceAt(text: string, at: number): Slice | null {
  const before = text.slice(0, at)
  const after = text.slice(at)

  if (/^\s*!/.test(text)) {
    /* The command, without the composer's own marker — that is syntax of this
       box, not of the shell, and a model asked for a command should not be told
       about it. */
    const line = before.replace(/^\s*!/, "")
    /* A lone `!token` is the project menu's (it lists helpers, scripts and what
       this project keeps running); the ghost owns a line with a space in it. */
    if (!line.includes(" ") || line.trim().length < 2) return null
    const rest = after.split("\n")[0] ?? ""
    return {
      prompt: line.slice(-MAX_PROMPT),
      ...(rest.trim() ? { suffix: rest } : {}),
      stop: ["\n"],
      maxTokens: SHELL_MAX_TOKENS,
      shell: true,
    }
  }

  /* Prose: enough to be a sentence, and never immediately after the character
     that opens a completer (`/`, `@`, `!`). */
  const prompt = before.slice(-MAX_PROMPT)
  if (prompt.trim().length < 3) return null
  if (/[/@!]$/.test(prompt)) return null
  const suffix = after.slice(0, MAX_SUFFIX)
  return {
    prompt,
    ...(suffix.trim() ? { suffix } : {}),
    maxTokens: PROSE_MAX_TOKENS,
    shell: false,
  }
}

/** The gap, as it can be inserted. A shell command keeps its first line, prose
    keeps at most two and 240 characters: a longer ghost grows the box under a
    thumb, and growing it is what moves the page — and the caret with it — while
    the reader is still typing. */
const PROSE_MAX_LINES = 2
const PROSE_MAX_CHARS = 240

function cleanGap(gap: string, slice: Slice): string {
  const lines = gap.replace(/\r/g, "").split("\n")
  const kept = (slice.shell ? lines.slice(0, 1) : lines.slice(0, PROSE_MAX_LINES)).join("\n")
  return (slice.shell ? kept : kept.slice(0, PROSE_MAX_CHARS)).replace(/\s+$/, "")
}

export function useFimCompletion({
  text,
  caret,
  insert,
  enabled,
  context,
}: {
  /** The composer's string, as of this render. */
  text: string
  /** A short recap of the thread (`thread/recap.ts`), so the gap can be finished
      as a *reply* and not only as a line. Capped there; the server caps it again. */
  context?: string
  /** The caret as an offset, or null when it is not a plain insertion point.
      Memoise it: it is an effect dependency. */
  caret: () => number | null
  /** Put a gap in at an offset, as an ordinary edit, and return the new string. */
  insert: (gap: string, at: number) => string
  /** Whether this composer may ask at all — a disabled box asks nothing. */
  enabled: boolean
}) {
  const settings = useServer()
  /* The connection, not the object: the effect below debounces, so it must not
     re-arm on a settings identity that happens to change. */
  const endpoint = settings.url
  const lane = useSideModel("completion")
  const ready = Boolean(lane.default)
  const [ghost, setGhost] = React.useState<FimGhost | null>(null)
  /* Why this is not silent any more: a lane that cannot resolve (a stale server,
     no default, a broken key) never asked anything, and "nothing happens" is
     indistinguishable from a feature that is off. `asking` says a request is on
     the wire; `failed` says one came back wrong, and carries the words. */
  const [status, setStatus] = React.useState<{ kind: "idle" | "asking" | "failed"; error: string | null }>({
    kind: "idle",
    error: null,
  })
  /** Where the editor should draw the "asking" mark: the caret the request was
      made at, so the indicator sits on the typing cursor's own line rather than
      in the toolbar. Null whenever nothing is on the wire. */
  const [pending, setPending] = React.useState<number | null>(null)
  /* One request in flight, and one number that says whether an answer is still
     the answer: an abort can lose the race with a response already on its way,
     so the sequence is what decides, not the abort. */
  const sequence = React.useRef(0)
  const inflight = React.useRef<AbortController | null>(null)
  /** The string our own insert produced, so it does not immediately ask again
      for the very gap it just filled. */
  const afterAccept = React.useRef<string | null>(null)

  React.useEffect(() => {
    /* Any change retires the suggestion: it was drawn for other text. */
    setGhost(null)
    setPending(null)
    /* Bail out of the render when it is already idle: this runs on every
       keystroke, and a fresh object here re-renders the whole box each time. */
    setStatus((prev) => (prev.kind === "idle" && prev.error === null ? prev : { kind: "idle", error: null }))
    inflight.current?.abort()
    if (!enabled || !ready) return
    if (afterAccept.current !== null) {
      const ours = text === afterAccept.current
      afterAccept.current = null
      if (ours) return
    }
    const at = caret()
    if (at === null) return
    const slice = sliceAt(text, at)
    if (!slice) return

    const timer = setTimeout(() => {
      const mine = ++sequence.current
      const controller = new AbortController()
      inflight.current = controller
      setStatus({ kind: "asking", error: null })
      setPending(at)
      void api<{ text: string; model: string }>(settings, "/api/fim", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          prompt: slice.prompt,
          /* A `!` line gets none of it: a shell command does not depend on the
             conversation, and a recap in front of it is what makes a code model
             continue the recap instead of the command. */
          ...(context && !slice.shell ? { context } : {}),
          ...(slice.suffix ? { suffix: slice.suffix } : {}),
          maxTokens: slice.maxTokens,
          ...(slice.stop ? { stop: slice.stop } : {}),
        }),
      })
        .then((answer) => {
          if (mine !== sequence.current) return
          setStatus({ kind: "idle", error: null })
          setPending(null)
          /* The caret can move without the text changing (an arrow key), which
             no effect above sees. A gap drawn at a caret that walked away is a
             suggestion for the wrong place. */
          if (caret() !== at) return
          const gap = cleanGap(answer.text, slice)
          if (gap) setGhost({ at, text: gap })
        })
        .catch((err: unknown) => {
          /* A cancelled request is not a failure — the next keystroke aborted it
             on purpose. A real failure is said in one line beside Send, because
             silence here reads as "the feature is off", which is exactly the
             wrong conclusion to draw from a bad key. */
          if (controller.signal.aborted || mine !== sequence.current) return
          setPending(null)
          setStatus({
            kind: "failed",
            error: err instanceof Error ? err.message : "the completion lane did not answer",
          })
        })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
    /* `insert` is not a dependency: it is only read by the key handler below,
       which is memoised on the ghost alone. */
  }, [text, enabled, ready, caret, endpoint, context])

  /* The one way a suggestion goes in, whichever gesture asked: Tab on a
     keyboard, a tap on the ghost or on the toolbar's button on a touch screen
     (a soft keyboard has no Tab). */
  const accept = React.useCallback((): boolean => {
    if (!ghost) return false
    afterAccept.current = insert(ghost.text, ghost.at)
    setGhost(null)
    return true
  }, [ghost, insert])

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (!ghost) return false
      /* Tab, and only the unmodified one: Shift-Tab is ProseMirror's own. */
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        return accept()
      }
      /* Escape drops the suggestion and nothing else: when no ghost is drawn
         this consumer declines, so Escape still means whatever it meant. */
      if (event.key === "Escape") {
        event.preventDefault()
        setGhost(null)
        return true
      }
      return false
    },
    [ghost, accept]
  )

  return { ghost, status, pending, accept, onKeyDown }
}

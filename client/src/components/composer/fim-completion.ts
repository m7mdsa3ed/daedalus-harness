/* ── Ghost text from a fill-in-the-middle model ──
 *
 * The composer's one ambient call (`docs/plans/fim-composer.md`): after a pause,
 * the lane's completion model is asked to fill the gap at the caret and the
 * answer is drawn as ghost text — never written into `text`, because `text` is
 * the exact message sent. Tab puts it in as an ordinary edit (on a touch screen,
 * where there is no Tab, a tap on the ghost or the toolbar's button does), the
 * word chord takes one word of it, Escape drops it, and the request chord asks
 * on demand — at once, for a longer gap, wherever the caret is.
 *
 * A suggestion lives as long as it is still true. Typing the characters it
 * shows walks through it (the rest stays drawn, nothing is re-asked); any other
 * edit, and any caret move, retires it, since it was drawn for other text at
 * another place. A gap the reader dropped with Escape, or took whole, is not
 * asked for again until the text changes.
 *
 * Two shapes, one hook. A `!` line is a shell command: prefix-only, one line,
 * and only once the command name is finished (`!/name args` — a lone `!token`
 * belongs to the project menu, not here). Everything else is prose, where the
 * gap is what the caret sits in the middle of and a newline is a legitimate
 * answer. Neither asks inside a token another completer owns (`/name`, `@path`).
 *
 * What it does *not* do: retry, toast, or hold the box. A suggestion is ambient,
 * so a failure is one quiet word beside Send — a toast per pause would cost more
 * than no ghost — and the settings row (Settings › AI, Composer) is where a
 * broken lane is diagnosed.
 */

import * as React from "react"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { useSideModel } from "@/lib/queries/side-models"
import { useChords } from "@/lib/keybindings"
import { matchesChord } from "@/lib/shortcuts"

/** Long enough that a thinking pause is not a request, and no faster than
    Codestral's free tier allows (~one request a second). */
const DEBOUNCE_MS = 900

/** How much of each side one request carries. A completion needs the sentence,
    not the transcript. */
const MAX_PROMPT = 2_000
const MAX_SUFFIX = 500

const SHELL_MAX_TOKENS = 32
const PROSE_MAX_TOKENS = 48
/** An asked-for gap is allowed to be longer: the reader pressed for it, so it
    is not a box growing under a thumb that did not ask. */
const ASKED_MAX_TOKENS = 128

/** Answers already paid for, by exactly what was sent: backspacing over a word
    and typing it again should not cost a second request. */
const CACHE_SIZE = 32

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
  /** The reader asked for this one (the request chord), rather than paused. */
  asked: boolean
}

/** The slice at a caret, or null when this is not a moment to ask. The thread's
    context is not composed here: it rides as its own field and the adapter puts
    it in front of the prompt (`server/src/fim.ts`), so it is written once. */
function sliceAt(text: string, at: number, asked: boolean): Slice | null {
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
      maxTokens: asked ? ASKED_MAX_TOKENS / 2 : SHELL_MAX_TOKENS,
      shell: true,
      asked,
    }
  }

  /* Another completer's token is not a gap: a lone `/name` is the command
     menu's and an `@path` under the caret is the mention menu's, and a ghost
     there would fight both for Tab. */
  if (/^\/\S*$/.test(before)) return null
  if (/(?:^|[\s(])@[^\s@]*$/.test(before)) return null

  /* Prose: enough to be a sentence (or anything at all, once asked), and never
     immediately after the character that opens a completer (`/`, `@`, `!`). */
  const prompt = before.slice(-MAX_PROMPT)
  if (prompt.trim().length < (asked ? 1 : 3)) return null
  if (/[/@!]$/.test(prompt)) return null
  const suffix = after.slice(0, MAX_SUFFIX)
  return {
    prompt,
    ...(suffix.trim() ? { suffix } : {}),
    maxTokens: asked ? ASKED_MAX_TOKENS : PROSE_MAX_TOKENS,
    shell: false,
    asked,
  }
}

/** The gap, as it can be inserted. A shell command keeps its first line, prose
    keeps at most two lines and 240 characters (six and 800 when asked for): a
    longer ghost grows the box under a thumb, and growing it is what moves the
    page — and the caret with it — while the reader is still typing. */
const PROSE_MAX_LINES = 2
const PROSE_MAX_CHARS = 240
const ASKED_MAX_LINES = 6
const ASKED_MAX_CHARS = 800

/** A tail of the gap that only repeats what already follows the caret. Two
    characters or more, or a run of closing punctuation — one letter in common
    is a coincidence, not an echo. */
function suffixEcho(gap: string, suffix: string): number {
  for (let n = Math.min(gap.length, suffix.length); n > 0; n--) {
    const head = suffix.slice(0, n)
    if (!gap.endsWith(head)) continue
    if (n >= 2 || /^[)\]}"'`.,;:]+$/.test(head)) return n
  }
  return 0
}

function cleanGap(gap: string, slice: Slice): string {
  let out = gap.replace(/\r/g, "")
  /* The model often opens with the space the reader already typed. */
  if (/\s$/.test(slice.prompt)) out = out.replace(/^[ \t]+/, "")
  const lines = out.split("\n")
  const maxLines = slice.shell ? 1 : slice.asked ? ASKED_MAX_LINES : PROSE_MAX_LINES
  out = lines.slice(0, maxLines).join("\n")
  if (!slice.shell) out = out.slice(0, slice.asked ? ASKED_MAX_CHARS : PROSE_MAX_CHARS)
  if (slice.suffix) {
    const echo = suffixEcho(out, slice.suffix)
    if (echo) out = out.slice(0, -echo)
  }
  return out.replace(/\s+$/, "")
}

/** The characters just typed, when they are exactly the next ones the ghost
    shows — the reader typing through the suggestion rather than past it. */
function typedThrough(prev: string, next: string, ghost: FimGhost): string | null {
  const grown = next.length - prev.length
  if (grown <= 0) return null
  if (next.slice(0, ghost.at) !== prev.slice(0, ghost.at)) return null
  if (next.slice(ghost.at + grown) !== prev.slice(ghost.at)) return null
  const typed = next.slice(ghost.at, ghost.at + grown)
  return ghost.text.startsWith(typed) ? typed : null
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
      as a *reply* and not only as a line. Capped there; the server caps it again.
      Read when a request is made, never a reason to make one: it moves on every
      streamed token, and a ghost must not flicker while a turn runs. */
  context?: string
  /** The caret as an offset, or null when it is not a plain insertion point (a
      selection, an IME composition). Memoise it: it is an effect dependency. */
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
  const wordChords = useChords("completionWord")
  const requestChords = useChords("completionRequest")
  const [ghost, setGhostState] = React.useState<FimGhost | null>(null)
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
  /** The caret as the editor last reported it (`onSelect`). A move that changes
      no text is still a reason to retire a ghost drawn somewhere else. */
  const [caretAt, setCaretAt] = React.useState<number | null>(null)
  /** Bumped by the request chord: a run of the effect that asks now. */
  const [askNonce, setAskNonce] = React.useState(0)

  /* One request in flight, and one number that says whether an answer is still
     the answer: an abort can lose the race with a response already on its way,
     so the sequence is what decides, not the abort. */
  const sequence = React.useRef(0)
  const inflight = React.useRef<AbortController | null>(null)
  const ghostRef = React.useRef<FimGhost | null>(null)
  const contextRef = React.useRef(context)
  contextRef.current = context
  const lastText = React.useRef(text)
  /** The text has changed since the last answer: a pause is worth a request. A
      caret move over text already answered for is not. */
  const fresh = React.useRef(false)
  /** A text the reader is done being offered things for — one they took a whole
      suggestion into, or dropped one with Escape on. Lifted by any edit. */
  const quiet = React.useRef<string | null>(null)
  const asked = React.useRef(false)
  const cache = React.useRef(new Map<string, string>())

  const show = React.useCallback((next: FimGhost | null) => {
    ghostRef.current = next
    setGhostState(next)
  }, [])

  React.useEffect(() => {
    const prevText = lastText.current
    const textMoved = text !== prevText
    lastText.current = text
    if (textMoved) fresh.current = true
    const askedNow = asked.current
    asked.current = false
    const at = caret()
    const prev = ghostRef.current

    /* Typed through: the rest of the suggestion is still the suggestion, now
       one keystroke further on. Nothing to ask for. */
    if (textMoved && prev && at !== null && !askedNow) {
      const typed = typedThrough(prevText, text, prev)
      if (typed !== null && at === prev.at + typed.length) {
        fresh.current = false
        const rest = prev.text.slice(typed.length)
        if (rest.trim()) {
          show({ at, text: rest })
        } else {
          show(null)
          quiet.current = text
        }
        return
      }
    }
    /* The editor restating the caret it already had: the ghost is where it is. */
    if (!textMoved && !askedNow && prev && at === prev.at) return

    /* Any other change retires the suggestion: it was drawn for other text. */
    show(null)
    setPending(null)
    /* Bail out of the render when it is already idle: this runs on every
       keystroke, and a fresh object here re-renders the whole box each time. */
    setStatus((s) => (s.kind === "idle" && s.error === null ? s : { kind: "idle", error: null }))
    inflight.current?.abort()
    if (!enabled || !ready || at === null) return
    if (!askedNow && (!fresh.current || quiet.current === text)) return
    const slice = sliceAt(text, at, askedNow)
    if (!slice) return

    /* A `!` line gets no recap: a shell command does not depend on the
       conversation, and a recap in front of it is what makes a code model
       continue the recap instead of the command. */
    const recap = !slice.shell ? contextRef.current || undefined : undefined
    const key = JSON.stringify([slice.prompt, slice.suffix ?? "", slice.maxTokens, slice.shell, recap ?? ""])
    const hit = cache.current.get(key)
    if (hit !== undefined) {
      fresh.current = false
      if (hit) show({ at, text: hit })
      return
    }

    const timer = setTimeout(
      () => {
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
            ...(recap ? { context: recap } : {}),
            ...(slice.suffix ? { suffix: slice.suffix } : {}),
            maxTokens: slice.maxTokens,
            ...(slice.stop ? { stop: slice.stop } : {}),
          }),
        })
          .then((answer) => {
            if (mine !== sequence.current) return
            setStatus({ kind: "idle", error: null })
            setPending(null)
            fresh.current = false
            const gap = cleanGap(answer.text, slice)
            cache.current.set(key, gap)
            if (cache.current.size > CACHE_SIZE) {
              cache.current.delete(cache.current.keys().next().value as string)
            }
            /* The caret can move without the text changing (an arrow key), and a
               gap drawn at a caret that walked away is a suggestion for the
               wrong place. */
            if (caret() !== at) return
            if (gap) show({ at, text: gap })
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
      },
      askedNow ? 0 : DEBOUNCE_MS
    )

    return () => clearTimeout(timer)
    /* `insert` and `context` are not dependencies: `insert` is only read by the
       key handlers below, and `context` is read through its ref when asking. */
  }, [text, caretAt, askNonce, enabled, ready, caret, endpoint, show])

  React.useEffect(() => () => inflight.current?.abort(), [])

  /** The editor's selection moved. */
  const onSelect = React.useCallback(() => setCaretAt(caret()), [caret])

  /** Ask now, at the caret, for a longer gap — bypassing the pause, the "already
      answered" rule and an Escape. */
  const request = React.useCallback((): boolean => {
    if (!enabled) return false
    if (!ready) {
      setStatus({ kind: "failed", error: "No completion model is set up (Settings › AI › Composer)" })
      return true
    }
    asked.current = true
    setAskNonce((n) => n + 1)
    return true
  }, [enabled, ready])

  /* The one way a suggestion goes in, whichever gesture asked: Tab on a
     keyboard, a tap on the ghost or on the toolbar's button on a touch screen
     (a soft keyboard has no Tab). */
  const accept = React.useCallback((): boolean => {
    if (!ghost) return false
    quiet.current = insert(ghost.text, ghost.at)
    show(null)
    return true
  }, [ghost, insert, show])

  /** One word of it — the leading space and the next run of non-space. The rest
      stays drawn: the insert reads as typing through it. */
  const acceptWord = React.useCallback((): boolean => {
    if (!ghost) return false
    const word = /^\s*\S+/.exec(ghost.text)?.[0] ?? ghost.text
    if (word === ghost.text) return accept()
    insert(word, ghost.at)
    return true
  }, [ghost, insert, accept])

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      /* Enter and Tab mean the IME's own thing while it is composing. */
      if (event.nativeEvent.isComposing) return false
      if (requestChords.some((chord) => matchesChord(event, chord))) {
        if (!request()) return false
        event.preventDefault()
        return true
      }
      if (!ghost) return false
      /* Tab, and only the unmodified one: Shift-Tab is ProseMirror's own. */
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        return accept()
      }
      if (wordChords.some((chord) => matchesChord(event, chord))) {
        event.preventDefault()
        return acceptWord()
      }
      /* Escape drops the suggestion and nothing else: when no ghost is drawn
         this consumer declines, so Escape still means whatever it meant. */
      if (event.key === "Escape") {
        event.preventDefault()
        quiet.current = lastText.current
        fresh.current = false
        show(null)
        return true
      }
      return false
    },
    [ghost, accept, acceptWord, request, requestChords, wordChords, show]
  )

  return { ghost, status, pending, accept, acceptWord, request, onSelect, onKeyDown }
}

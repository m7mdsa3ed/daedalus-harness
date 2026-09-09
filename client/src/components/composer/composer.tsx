/* ── Composer ──
   The box, the shelf above it and the toolbar beneath. One component for every
   surface that takes a prompt.

   ── The card is three bands ──
   **The scope band on top** — where this thread runs, what it carries, and how
   full its window is: project · tools · … · the context ring. It is the band
   that does not change when the thread starts. Both halves used to be
   draft-only rows on the shelf, which meant the project vanished at the moment
   it started mattering: while you were typing the *first* message you could see
   which directory the agent would edit, and from the second message on you
   could not. A started thread's project is fixed (it is the cwd) so it reads
   out rather than picks, and the tools menu already knew how to do both. The
   ring at the end is the same `ContextIndicator` the tab wears, opening upward.

   **The textarea.** **Then one toolbar** that reads left to right as *what goes
   in → who answers → what happens*: the "+" menu (attach, photo, mention,
   command, code block), the model/config cluster, then the counters and the
   actions, ending on a filled Send. Every control on the row is the same shape
   and chrome-less except the two that carry meaning by colour: Send is primary,
   Stop is destructive. The scale follows the pointer — 24px (`icon-xs`) under a
   mouse, 32px (`icon-sm`) under a finger, where the same row had to double as a
   touch target (`useCoarsePointer`, see below).

   Nothing else is in the card. The shelf above it (`ComposerStrip`) holds every
   *state you consult while typing* — the queue, the checklist, the running
   subagents, attachments, pastes — and it tucks its bottom edge behind the
   scope band, so what is transient stacks above what is permanent.

   What used to be five separate buttons (attach, voice, pause, stop, send)
   competing for a row that is 300px wide on a phone is now a menu on the left
   and one action on the right. The "+" holds everything that *adds to* the
   message; the end of the row holds the one action the state calls for — the
   mic while the box is empty, Send as soon as something is in it, and Stop
   beside either while a turn runs. Queue and steer are still the two sends
   (⏎ and the steer chord), said in Send's tooltip rather than in a menu.

   Features the toolbar offers beyond the old row:
   — a length reading once a prompt is long enough for its size to matter,
     with a rough token estimate (4 chars ≈ 1 token — an estimate, said as one);
   — camera capture on touch (`capture="environment"` on a second picker);
   — Clear, which puts back the box, the parked pastes and the attachments in
     one go, from the "+" menu.

   Everything about what a *send* is — the empty rule, the upload gate, the
   draft/pastes/attachments carried back on failure, `beforeSend`, `/schedule`
   interception — is unchanged from the version that lived in thread-view.tsx,
   and the comments on it travelled with it.

   ── What lives beside this file ──
   The card and its two rows are here, because the rule is about the two of
   them together. The pieces that are a subject of their own are not:
   `notices.tsx` (the two dashed notes above the shelf), `add-menu.tsx` (the
   "+", and the pickers only it clicks), `text-insertions.ts` (what that menu
   types on the user's behalf), `enhance-button.tsx` (the rewrite and every
   read behind it), `keys.ts` (the one ordering of Enter and the completers),
   `prompt-history.ts` (the Up walk). */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"
import { ArrowUp, History, Mic, Pause, Play, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Shortcut } from "@/components/shortcut"
import {
  AgentsIndicator,
  ChangesIndicator,
  ConfigIndicator,
  ContextIndicator,
  TodoIndicator,
} from "@/components/composer-status"
import { ComposerAttachments, ComposerPastes, type AttachmentDelivery } from "@/components/composer-attachments"
import { ComposerHistoryDialog } from "@/components/composer-history-dialog"
import { ComposerStrip, ComposerStripItem } from "@/components/composer-strip"
import { ComposerAddMenu } from "@/components/composer/add-menu"
import { ComposerNotices } from "@/components/composer/notices"
import { EnhanceButton } from "@/components/composer/enhance-button"
import { composerKeyDown } from "@/components/composer/keys"
import { usePromptHistory } from "@/components/composer/prompt-history"
import { selectionOf, textInsertions } from "@/components/composer/text-insertions"
import { DraftConfigPopover, DraftScopeRow } from "@/components/draft-config"
import { SessionConfigPopover } from "@/components/session-config"
import { FileMentionMenu, useFileMentions } from "@/components/file-mentions"
import {
  HARNESS_COMMANDS,
  SlashCommandMenu,
  harnessCommandFor,
  useSlashCommands,
} from "@/components/slash-commands"
import { useComposerAttachments } from "@/hooks/use-composer-attachments"
import { useCoarsePointer, useIsMobile } from "@/hooks/use-device"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { useComposerPrefs } from "@/lib/composer-prefs"
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
import { reportError } from "@/lib/errors"
import { useChords } from "@/lib/keybindings"
import {
  clearPastes,
  dropPaste,
  expandPastes,
  isLongPaste,
  livePastes,
  loadPastes,
  mintPaste,
  pasteToken,
  savePastes,
  type Paste,
} from "@/lib/pastes"
import { useComposerHistory, useRecordComposerHistory } from "@/lib/queries"
import { currentThreadId, schedulePath } from "@/lib/router"
import type { SessionMeta } from "@/lib/settings"
import { formatChord } from "@/lib/shortcuts"
import { composerLock } from "@/lib/thread/phase"
import type { ThreadState } from "@/lib/store"
import type { TurnChanges } from "@/lib/workspace/git-api"
import { holdOf } from "@/lib/thread/hold"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/* Past this the prompt is long enough that its size is worth a reading, and
   the expand toggle is worth a slot on the row. Both are about the same
   question — "is this more than a sentence" — so they share one answer. */
const LONG_PROMPT_CHARS = 240
const LONG_PROMPT_LINES = 3

/** What the transcript's suggestion card can ask the composer to do. The card
    lives next to the answer that offered the prompts, far from the box, so the
    fill goes through a handle rather than shared state — and the handle is
    imperative because filling is a moment, not a mode. */
export interface ComposerHandle {
  /** Fill the box like a history recall: replaced, unsent, caret at the end. */
  fill(prompt: string): void
  /** Whether a `fill` would replace anything. Escape's take-back asks first:
      the message it hands back has already left the queue by the time it
      arrives, so it must never land on top of something typed since. */
  isEmpty(): boolean
}

export function Composer({
  sessionId,
  actions,
  thread,
  meta,
  /* Resolved by ThreadView and handed down: the transcript's error rows read
     the same answer (see `wentInline`), and two `useAttachmentDelivery` calls
     in one tree would be two subscriptions to the same absolute state. */
  delivery,
  changes,
  onOpenChanges,
  beforeSend,
  placeholder,
  autoFocus,
  ref,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
  delivery: AttachmentDelivery
  /** The newest turn that wrote to the worktree, already gated by the
      transcript (`withTurnChanges`) — the composer holds no opinion about
      which turn qualifies, only about where the reading is drawn. */
  changes?: TurnChanges
  onOpenChanges?: (turn: TurnChanges) => void
  /** Awaited between "the words have been taken" and the send itself; `false`
      (or a throw) puts them back in the box and sends nothing. While it runs
      the send button shows busy. The build page scaffolds the project here. */
  beforeSend?: (text: string) => Promise<boolean>
  /** Overrides the idle placeholder only; the lock and queue notes still win. */
  placeholder?: string
  /** Take the caret without being the routed thread — the landing console,
      whose route is `/` and whose only purpose is this box. Still refused on
      touch, and still only for a draft. */
  autoFocus?: boolean
  ref?: React.Ref<ComposerHandle>
}) {
  const navigate = useNavigate()
  const location = useLocation()
  /* The draft lives on this device, per session (lib/drafts). ThreadView is
     keyed by the thread's key today so the initializer would be enough — the
     effect keeps it correct if that key ever goes away. */
  const [text, setText] = React.useState(() => loadDraft(sessionId))
  /* The box as it is NOW, for the one reader that runs long after the render it
     was written in: a send that fails asks whether the composer is still the
     empty one it left behind before putting the words back. */
  const textRef = React.useRef(text)
  textRef.current = text
  React.useEffect(() => setText(loadDraft(sessionId)), [sessionId])
  React.useEffect(() => saveDraft(sessionId, text), [sessionId, text])
  /* The sidecar for long pastes: the body is parked here and a token stands in
     for it in `text` (lib/pastes). Same per-session localStorage bargain as the
     draft, in a second key rather than a widened value — every caller of
     `loadDraft` depends on it being a string. */
  const [pastes, setPastes] = React.useState<Paste[]>(() => loadPastes(sessionId))
  React.useEffect(() => setPastes(loadPastes(sessionId)), [sessionId])
  React.useEffect(() => savePastes(sessionId, pastes), [sessionId, pastes])
  /* A chip is a view of a token, so a token the user deleted drops its paste —
     checked on every keystroke, and again at send. Kept as a derived list
     rather than by pruning state: pruning inside a render is a write during a
     render, and the persisted array is what a reload has to agree with. */
  const shownPastes = React.useMemo(() => livePastes(text, pastes), [text, pastes])
  /* Files, which are not text and so cannot be a token in it: they are
     uploaded as they are picked and travel as references beside the prompt. */
  const files = useComposerAttachments(sessionId)
  const [dragging, setDragging] = React.useState(false)
  const dragCounter = React.useRef(0)
  /* `beforeSend` in flight: the box is taken, the button is busy. */
  const [gated, setGated] = React.useState(false)
  /* The turn is held at its step boundary — by the user's pause, or because
     it failed and is waiting rather than having ended (`lib/thread/hold.ts`).
     It changes two things here and nothing else: what a plain send does, and
     what the box says it will do. */
  const hold = holdOf(thread)
  const isMobile = useIsMobile()
  const coarse = useCoarsePointer()
  const prefs = useComposerPrefs()
  // Rebindable in Settings › Keyboard, so it is read rather than named here.
  const steerChords = useChords("steer")
  const voice = useVoice((transcript) => setText((t) => (t ? t + " " : "") + transcript))
  /* A draft has no connection, so none of the connection states apply to it —
     it is waiting to be typed into, which is the one case where the composer
     must stay live whatever else is true. Everything else comes from the phase:
     `typable` is almost always true (refusing words the user has already written
     is the bug, not the safety) and `submittable` is what goes false while a
     thread is opening — which is what stops a second Enter on a draft from
     POSTing the same session id twice. */
  const draft = meta?.draft === true
  const lock = composerLock(thread.phase, draft)
  const disabled = !lock.typable

  /* The schedule form, pre-filled. Reached two ways — `/schedule` typed into
     the box and "Schedule…" in the send menu — and both are the same move:
     the text goes to the form expanded (the form stores it on the server,
     where the sidecar a token points into does not exist) and the draft is
     deliberately NOT cleared, because nothing has been sent and the form is a
     place you can back out of. */
  const openSchedule = (message: string) => {
    void navigate(schedulePath(sessionId), {
      state: {
        defaultText: expandPastes(message, pastes),
        returnTo: location.pathname + location.search,
      },
    })
  }

  /* The draft is cleared optimistically: a failure leaves a transcript row that
     carries the exact text and a Retry button, which is a better home for it
     than a textarea the user has since typed into.

     `/schedule` is intercepted here rather than sent: it is the harness's own
     command (see slash-commands.tsx), so its text opens the schedule form
     pre-filled instead of reaching the agent. */
  /* The prompt history is the server's and global (lib/composer-history): what
     Up walks, and what the history page lists. Read here so a recall is served
     from the cache rather than a round trip. */
  const composerHistory = useComposerHistory()
  const recordHistory = useRecordComposerHistory()
  const [historyOpen, setHistoryOpen] = React.useState(false)

  const send = async (opts: { steer?: boolean } = {}) => {
    if (gated) return
    /* A held turn is stopped, not running — so Enter *steers* it rather than
       queueing behind it. The queue drains when a turn ends, and a held turn
       never ends on its own: words queued here sat there until the user
       noticed, and a *paused* turn was the worse case, because Resume is the
       only thing that would ever drain them and nothing said so. Steered,
       they join the turn at the boundary it is waiting at, which is exactly
       when they are wanted — "try the other file instead" said while it
       waits, delivered on Continue or Resume. The steer chord still means
       what it always did; this only changes what the plain send does, and
       only while the turn is held. */
    const steering = opts.steer ?? hold.paused
    const value = text.trim()
    /* The one place the empty-prompt rule lives, and it has learned about
       attachments: an image with no sentence is a real prompt. An upload still
       in flight is not — the prompt would name a row the server does not have
       yet — so it waits rather than sending less than was meant. */
    if (!value && files.ready.length === 0) return
    if (files.uploading) return
    /* The thread is on its way to existing (a create or a respawn POST is in
       flight, or the transcript is still being read). The words stay in the box
       rather than being taken and dropped: Enter used to re-enter `actions.send`
       here, find the row still flagged as a draft, and POST the same session id
       a second time — which the server answers with a 409 and the user sees as
       a failure to send the message that was already sending. */
    if (!lock.submittable) return
    const command = draft ? null : harnessCommandFor(value, thread.availableCommands)
    if (command?.name === "schedule") {
      openSchedule(command.args)
      return
    }
    /* Gated on the capability rather than on the menu, because the menu is only
       an affordance: a `/compact` typed out in full on a runtime that does not
       take the request falls through and is sent as a prompt, which is what the
       user asked for and possibly what that agent understands. */
    if (command?.name === "compact" && thread.canCompact) {
      setText("")
      clearDraft(sessionId)
      void actions.compact(sessionId)
      return
    }
    /* The tokens become their bodies here, at the last moment, exactly as
       `mentions.ts` derives resource links from the text at the last moment.
       Everything downstream sees the string it always did. */
    const outgoing = expandPastes(value, pastes)
    const attachments = files.ready.map(({ id, name, mimeType, size }) => ({
      id,
      name,
      mimeType,
      size,
    }))
    /* Kept for the send that never leaves: what goes back in the box is what
       was typed, tokens and all, not the expanded string that went out. */
    const carriedPastes = pastes
    const carriedFiles = files.attachments
    setText("")
    setPastes([])
    clearDraft(sessionId)
    clearPastes(sessionId)
    files.clear()
    /* A message that never reached the server comes back here rather than
       surviving only as a Retry button on a `local` error row — which is a row
       this device alone holds and a reload deletes, taking the words with it.
       Refused when the user has started typing again: that is a different
       message, and `actions.send` keeps Retry on the row for exactly that. */
    const onUnsent = () => {
      if (textRef.current.trim()) return false
      setText(value)
      setPastes(carriedPastes)
      files.restore(carriedFiles)
      return true
    }
    /* The gate runs with the box already cleared, on purpose: what it does
       may navigate (the build page opens the thread it just made), and a
       composer mounting on the new route reads this device's draft storage —
       which must not still hold the words that are about to be sent. A `false`
       is the same recovery a send that never left gets. */
    if (beforeSend) {
      setGated(true)
      let ok = false
      try {
        ok = await beforeSend(value)
      } catch {
        ok = false
      } finally {
        setGated(false)
      }
      if (!ok) {
        onUnsent()
        return
      }
    }
    /* Recorded once the send has actually left, never before: a message that
       died on the way back into the box (`onUnsent`) is still in the composer,
       and a history that already holds it would offer the same words twice.
       `actions.send` resolves for all three commit paths — the draft it had to
       create first, the prompt, and the message that was queued behind a
       running turn — and rejects for every failure, so this one `then` is the
       whole of "what we sent".

       The words recorded are `value`, what was *typed*, not the `outgoing`
       string with its paste tokens expanded: recalling a line should put the
       same short token back in the box, not the document behind it.

       Fire and forget, and its failure is swallowed: a history that did not
       record is not a send that failed, and there is nothing the user would do
       about it. */
    void actions
      .send(sessionId, outgoing, { ...opts, steer: steering, attachments, onUnsent })
      .then(() => {
        if (!value) return
        recordHistory.mutate({ text: value, sessionId, threadTitle: meta?.title ?? null })
      })
      .catch(() => {})
  }

  /* Up/Down walk what has already been sent — from anywhere, not just here.
     It goes after the slash menu in the key handler below: while that menu is
     open the arrows are its. */
  const history = usePromptHistory(composerHistory.items, setText)

  /* Running an agent command is just sending `/name args` as the prompt — the
     agent resolves it — so the menu only completes the name. Drafts advertise
     no commands (no process yet); they are also offered no harness commands,
     because `/schedule` needs a thread the server knows about to schedule
     against, which a draft is not until its first message. */
  /* A draft has no process, so it is offered none of these. `/compact` is
     dropped again where the runtime does not take the request — offering a
     command that can only answer "this agent decides for itself" is worse than
     not offering it. */
  const harnessCommands = draft
    ? []
    : HARNESS_COMMANDS.filter((c) => c.name !== "compact" || thread.canCompact)
  const slash = useSlashCommands(text, thread.availableCommands, setText, harnessCommands)
  const hasCommands = thread.availableCommands.length > 0 || harnessCommands.length > 0

  /* `@` completes a path in the project. It reads the token at the caret — a
     file is named mid-sentence, unlike a command — so the textarea has to be
     reachable. It goes after the command menu in the key handler for the same
     reason history does: whichever menu is open owns the arrows. The two cannot
     both be open (a `/name` token holds no `@`), but the order is stated rather
     than relied upon. */
  const composerRef = React.useRef<HTMLTextAreaElement>(null)

  /* A new thread is a route change into an empty screen whose only purpose is
     the box, so the box takes the caret itself — "New thread" then typing,
     with nothing to click in between. Scoped tightly, because focus taken
     wrongly is worse than focus not taken:
     — only a draft (an existing thread is opened to read at least as often as
       to write to, and stealing focus there scrolls a phone to the bottom);
     — only while this thread is the routed one, since the dock keeps every
       opened transcript mounted and a background panel must not grab the caret
       — or while the caller says so (`autoFocus`), which is the landing
       console: its draft is never the routed thread (the route is `/`), so it
       was the one new thread whose box the user had to click into;
     — never on touch, where focusing raises the keyboard over the screen the
       user has just arrived at.
     After a frame: dockview moves focus itself as it activates a new panel,
     and the later mover wins. */
  const routed = currentThreadId(location.pathname, location.search) === sessionId
  React.useEffect(() => {
    if (!draft || isMobile || !(routed || autoFocus)) return
    const frame = requestAnimationFrame(() => composerRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [sessionId, draft, routed, autoFocus, isMobile])

  const mentions = useFileMentions({
    text,
    setText,
    projectId: meta?.projectId,
    inputRef: composerRef,
  })

  const { insertMention, insertCommand, insertCodeBlock } = textInsertions({
    text,
    setText,
    requestCaret: mentions.requestCaret,
    inputRef: composerRef,
  })

  /* Everything that would have gone: the words, the parked pastes and the
     files. The persisted copies go with them — a draft cleared here and
     restored by a reload is a draft the user cleared twice. */
  const clearAll = () => {
    setText("")
    setPastes([])
    clearDraft(sessionId)
    clearPastes(sessionId)
    files.clear()
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  /* A suggested follow-up picked from its card in the transcript: it fills the
     box the way a history recall does — replaced, unsent, editable — and takes
     the caret to its end. The caret goes through the mention hook's slot for
     the reason `onPaste` gives: rewriting `text` is a render, and the wanted
     position has to be re-applied after it. The card is a sibling of this
     component, so the fill is exposed as the imperative handle rather than
     shared state. It is also where the prompt enhancer's rewrite lands: that
     is the same act — replaced, unsent, caret at the end. */
  const applySuggestion = React.useCallback(
    (prompt: string) => {
      setText(prompt)
      mentions.requestCaret(prompt.length)
      requestAnimationFrame(() => composerRef.current?.focus())
    },
    [mentions.requestCaret]
  )
  React.useImperativeHandle(
    ref,
    () => ({ fill: applySuggestion, isEmpty: () => text.trim() === "" }),
    [applySuggestion, text]
  )

  /* A long paste is parked rather than pasted: the token goes in at the caret
     and the body waits in the sidecar until send. Below the threshold nothing
     happens at all — the affordance has to be invisible for the pastes people
     actually make (a URL, an error line, a name).

     The caret is the same hazard `file-mentions.tsx` documents: rewriting
     `text` is a render, and the caret it wants has to be re-applied *after*
     that render and ahead of the sync from `selectionStart`. So it goes through
     that hook's own slot rather than a second mechanism racing it. */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    /* Files BEFORE text: a screenshot on the clipboard usually carries a
       text/plain fallback too, and reading text first would turn every
       screenshot paste into an empty chip. */
    const pastedFiles = [...event.clipboardData.files]
    if (pastedFiles.length > 0) {
      event.preventDefault()
      files.add(pastedFiles)
      return
    }
    const plain = event.clipboardData.getData("text/plain")
    if (!plain || !isLongPaste(plain)) return
    event.preventDefault()
    const el = event.currentTarget
    const [start, end] = selectionOf(el, text.length)
    const paste = mintPaste(pastes, plain)
    const token = pasteToken(paste.n)
    setPastes([...pastes, paste])
    mentions.requestCaret(start + token.length)
    setText(text.slice(0, start) + token + text.slice(end))
  }

  const removePaste = (n: number) => {
    const next = dropPaste(text, pastes, n)
    setText(next.text)
    setPastes(next.pastes)
  }


  /* What the row reads about the prompt. `lines` counts newlines rather than
     wrapped rows: the wrap depends on the width and the reading should not
     change as a panel is dragged. */
  const chars = text.length
  const lines = chars === 0 ? 0 : text.split("\n").length
  const long = chars >= LONG_PROMPT_CHARS || lines >= LONG_PROMPT_LINES
  const hasContent = text.trim().length > 0 || files.attachments.length > 0 || shownPastes.length > 0
  const canSend =
    !disabled &&
    !gated &&
    lock.submittable &&
    !files.uploading &&
    (text.trim().length > 0 || files.ready.length > 0)
  /* Touch targets: the row was written at the 24px xs scale, which is a small
     target to hold a thumb on. Under a coarse pointer every control grows to
     the 32px icon-sm scale — still one language across the row, still inside
     the composer card where the filled Send keeps the eye. */
  const iconSize = coarse ? "icon-sm" : "icon-xs"
  const steerChord = formatChord(steerChords[0] ?? "")

  const sendTitle = gated
    ? "Working…"
    : hold.paused
      ? hold.sendHint
      : thread.turnActive
        ? `Queue (${steerChord} steers the running turn instead)`
        : "Send"

  return (
    <div className="pointer-events-auto px-4 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <ComposerNotices sessionId={sessionId} actions={actions} thread={thread} />
      <ComposerStrip
        /* ── The scope row ──
           Where this thread runs, what it carries, how full it is — the shelf's
           floor, under whatever the turn has put on it. It survives the first
           message: the row is the same either side of it, only the project
           stops being a choice. The ring is here rather than on the send row
           because context occupancy is a fact about the thread, not a control.
           Nothing without a `meta`, which is a thread the server has not
           answered for yet. */
        footer={
          meta && (
            <DraftScopeRow
              meta={meta}
              actions={actions}
              editable={draft}
              /* The readings, in one cluster at the row's end: how far the
                 checklist has got, how many workers are out, what the last
                 turn wrote, how full the window is. Four answers of the same
                 *kind* — one number that is true of the thread right now,
                 glanced at constantly and read in full rarely — so they are
                 one shape (a 24px trigger over a popover) in one place, rather
                 than a card on a shelf each. Every one of them draws nothing
                 when it has nothing to say, so an idle thread's cluster is the
                 ring alone. */
              trailing={
                <>
                  <ConfigIndicator thread={thread} sessionId={sessionId} actions={actions} />
                  <TodoIndicator thread={thread} />
                  <AgentsIndicator thread={thread} />
                  <ChangesIndicator changes={changes} onOpen={onOpenChanges} />
                  <ContextIndicator
                    thread={thread}
                    meta={meta}
                    actions={actions}
                    side="top"
                    size="icon-xs"
                  />
                </>
              }
            />
          )
        }
      >
        {/* The shelf is only what is about the message being typed. The
            checklist and the running-agent count are readings of the *thread*
            and live in the footer's cluster; the queue is the user's own
            sentences and lives in the transcript, as sentences. */}
        {/* What is riding along with the message but is not in the box: a file. */}
        <ComposerAttachments
          attachments={files.attachments}
          delivery={delivery}
          onRemoveAttachment={files.remove}
          onRetryAttachment={files.retry}
        />
        {/* Long pastes, parked as tokens in the textarea, shown as chips.
            Moved from inside the card to the strip so pastes and files are
            managed on the same shelf. */}
        <ComposerPastes pastes={shownPastes} onRemove={removePaste} />
        {/* Says what the box is showing and how to get back out of it — without
            it, a recalled prompt is indistinguishable from one you typed. */}
        {history.browsing && (
          <ComposerStripItem
            summary={{ id: "history", icon: History, label: "Earlier prompt" }}
            className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"
          >
            <History className="size-3" />
            <span>Earlier prompt</span>
            {/* The way out, for the pointer that has one. Hidden on touch —
                there is no Esc key on a phone, so it is an instruction that
                cannot be followed taking up the end of the row. */}
            <span className="ms-auto hidden items-center gap-1.5 sm:flex">
              <Shortcut chord="esc" />
              to go back
            </span>
          </ComposerStripItem>
        )}
        {/* Last on the shelf, nearest the composer: these suggestions are about
            the text being typed right now, where everything above belongs to
            the turn. It is a row, not an overlay, so the plan and the history
            notice stay readable while you complete a command. */}
        <SlashCommandMenu state={slash} />
        <FileMentionMenu state={mentions} />
      </ComposerStrip>
      {/* relative/z-10: the composer paints over the strip's tucked bottom edge.
          It wears the same soft shadow and hairline ring as the app's floating
          menus, with the ring in the accent rather than plain foreground, so
          the card reads as the raised, accent-framed top of the composer unit. Deliberately no focus
          ring: the caret in the textarea is the "you are typing here" signal.
          The only ring change is destructive, while voice is listening.

          It is also the drop target, and deliberately the whole card rather
          than the textarea: a file aimed at "the composer" lands on the button
          row or the padding as often as on the box. `dragCounter` is what makes
          the overlay stable — `dragleave` fires as the pointer crosses into a
          child, so a boolean would flicker the whole way across. */}
      <div
        data-slot="composer-card"
        className={cn(
          "relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl bg-composer/70 p-2 shadow-2xl backdrop-blur-xl backdrop-saturate-150",
          "ring-1 ring-foreground/5 transition-[ring-color] duration-200 dark:ring-foreground/10",
          voice.listening && "ring-destructive/40"
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
        }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          dragCounter.current += 1
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          dragCounter.current -= 1
          if (dragCounter.current <= 0) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          dragCounter.current = 0
          setDragging(false)
          files.add(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-composer/80 text-xs font-medium text-primary">
            Drop to attach
          </div>
        )}
        <Textarea
          ref={composerRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onSelect={mentions.onSelect}
          onPaste={onPaste}
          onKeyDown={composerKeyDown({
            slash,
            mentions,
            history,
            isMobile,
            enterSends: prefs.enterSends,
            steerChords,
            send,
          })}
          aria-label="Message the agent"
          placeholder={
            lock.note ??
            (voice.listening && !text
              ? "Listening…"
              : hold.paused
                ? `${hold.sendHint}…`
                : thread.turnActive
                  ? "Queue a message for when the agent finishes…"
                  : (placeholder ?? "Message the agent…"))
          }
          disabled={disabled || gated}
          rows={1}
          className={cn(
            "min-h-9 w-full resize-none border-0 bg-transparent px-2 py-1.5 leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent",
            /* Same reading size as the transcript's messages: the card carries
               the `--text-xs` bump `.thread-transcript` sets, so `text-xs`
               here is 0.875rem and typing matches what is being answered. */
            "text-xs md:text-xs",
            /* The box grows to ten lines and then scrolls. */
            "max-h-40",
            /* Roomier under a thumb: the caret row leading its 32px buttons
               is how the row stays visually centred while the targets grow. */
            coarse && "min-h-11"
          )}
        />
        {/* One control language across the row: every button is the same
            size — 24px (`icon-xs`), the app's xs scale, mouse and finger
            alike — rounded-lg, and chrome-less with a hover wash. The row
            sits INSIDE the composer card, so a bordered button there is a
            box inside a box; colour carries the meaning instead, and only on
            the two that act on the message as a whole: Send is a filled
            primary disc, Stop a destructive one. */}
        <div
          data-slot="composer-toolbar"
          className={cn("flex items-center gap-1 pt-1", coarse && "gap-1.5 pt-1.5")}
        >
          <ComposerAddMenu
            disabled={disabled || gated}
            size={iconSize}
            coarse={coarse}
            onFiles={files.add}
            canMention={Boolean(meta?.projectId)}
            hasCommands={hasCommands}
            hasHistory={composerHistory.items.length > 0}
            hasContent={hasContent}
            onMention={insertMention}
            onCommand={insertCommand}
            onCodeBlock={insertCodeBlock}
            onHistory={() => setHistoryOpen(true)}
            onClear={clearAll}
          />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Who answers. Before the session exists the profile catalog is the
                only thing that knows the choices; after it, the agent is. Two
                controls, one slot — see CLAUDE.md's rule about which owns the
                model. The kit this thread carries is NOT here: it moved to the
                scope band above, beside the project, where it is the same
                read-out on a started thread that it is a picker on a draft. */}
            {draft && meta ? (
              <DraftConfigPopover meta={meta} actions={actions} />
            ) : (
              <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} />
            )}
          </div>
          {/* How long the prompt is, once that is worth knowing. The token
              figure is an estimate and is printed as one (the tilde); it is
              there so a pasted document reads as "about 3k tokens" before it
              is sent, not after. Only where the row has room for words. */}
          {long && (
            <span
              className="hidden shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground @panel-sm:inline"
              title={`${chars.toLocaleString()} characters, ${lines} lines — roughly ${formatTokens(Math.ceil(chars / 4))} tokens`}
            >
              {formatTokens(chars)} · ~{formatTokens(Math.ceil(chars / 4))} tok
            </span>
          )}
          {/* The prompt enhancer. The button rewrites the draft through the AI
              SDK against the profile picked in Settings › General; the pick
              lives there, not here, because it is a device habit like the
              thread defaults rather than a property of the thread. */}
          <EnhanceButton
            sessionId={sessionId}
            meta={meta}
            draft={draft}
            text={text}
            disabled={disabled}
            gated={gated}
            hasContent={hasContent}
            size={iconSize}
            onEnhanced={applySuggestion}
          />
          {voice.supported && (voice.listening || (!hasContent && !gated)) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
                // Listening is a live state, so it stays coloured — but as text,
                // not as a filled chip that reintroduces the chrome.
                voice.listening && "animate-pulse text-destructive hover:text-destructive"
              )}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title={voice.listening ? "Stop listening" : "Voice input"}
              aria-pressed={voice.listening}
            >
              <Mic />
            </Button>
          )}
          {/* Pause is the harness's own agent's, not ACP's: the runtime holds
              at its next step boundary and carries on from there, where Stop
              throws the step away. Shown while a turn runs, and while a hold
              is on — a paused session with no turn open holds its next prompt,
              so the toggle has to be there to take it off.

              The same control releases a turn the *runtime* held, because it
              is the same hold: a turn that failed waits at the same boundary
              for the same resume. Only the words change — after a model change
              this is Continue, and continuing is what it does. */}
          {thread.canPause && (thread.turnActive || thread.paused) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
                thread.paused && "text-primary hover:text-primary"
              )}
              onClick={() =>
                (thread.paused ? actions.resume(sessionId) : actions.pause(sessionId)).catch((err) =>
                  reportError(err, thread.paused ? "Couldn't resume the turn" : "Couldn't pause the turn")
                )
              }
              title={
                hold.byError
                  ? "Continue — change the model first if the same one will fail again"
                  : hold.paused
                    ? "Resume"
                    : "Pause at the next step"
              }
            >
              {thread.paused ? <Play /> : <Pause />}
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="ghost"
              size={iconSize}
              className="shrink-0 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              /* Stop and Escape are the same gesture, so they answer the same
                 way: a message the user has not seen land comes back into the
                 box rather than staying parked in a queue nothing will drain.
                 Only into an empty one — see `ComposerHandle.isEmpty`. */
              onClick={() =>
                actions
                  .stop(sessionId, {
                    ...(text.trim() === "" ? { onReclaim: applySuggestion } : {}),
                  })
                  .catch(() => {})
              }
              title="Stop"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          {(hasContent || gated) && (
            <Button
              variant="default"
              size={iconSize}
              className="shrink-0 rounded-full shadow-sm disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              onClick={() => void send()}
              disabled={!canSend}
              title={sendTitle}
              aria-label={sendTitle}
            >
              {gated ? <Spinner className="size-3.5" /> : <ArrowUp className="size-3.5" strokeWidth={2.5} />}
            </Button>
          )}
        </div>
      </div>
      {/* Outside the card so the dialog is not inside the element it writes
          into. Picking replaces the box rather than appending: this is
          "recall that prompt", the same act Up performs, and appending would
          make the two doors onto one list behave differently. */}
      <ComposerHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onPick={(picked) => {
          setText(picked)
          requestAnimationFrame(() => {
            const el = composerRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }}
      />
    </div>
  )
}

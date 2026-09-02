/* ── Composer ──
   The box, the shelf above it and the toolbar beneath. One component for every
   surface that takes a prompt: the thread view and the build page (which
   drafts a thread it has not opened yet — see `build-page.tsx`).

   The card is two rows and nothing else. The textarea on top, and under it one
   toolbar that reads left to right as *what goes in → where it goes → what
   happens*: the "+" menu (attach, photo, mention, command, code block), the
   model/config cluster, then the counters and the actions, ending on a filled
   Send. Every control on the row is the same shape — 32px on a mouse, 36px on
   a finger (`useCoarsePointer`, the device's answer; `useIsMobile` is the
   width's and decides only what Enter means) — and chrome-less except the two
   that carry meaning by colour: Send is primary, Stop is destructive.

   What used to be five separate buttons (attach, voice, pause, stop, send)
   competing for a row that is 300px wide on a phone is now a menu on the left
   and a menu on the right. The "+" holds everything that *adds to* the
   message; the chevron beside Send holds everything about *how it goes* —
   queue or steer while a turn runs, schedule it, and what Enter does. On touch
   the send menu is also a long-press on Send, on a mouse a right-click, so the
   chevron is a hint rather than the only door.

   Features the toolbar offers beyond the old row:
   — expand: a long prompt gets a taller box (the panel's height, not a fixed
     forty units) with one click, and folds back the same way;
   — a length reading once a prompt is long enough for its size to matter,
     with a rough token estimate (4 chars ≈ 1 token — an estimate, said as one);
   — camera capture on touch (`capture="environment"` on a second picker);
   — the Enter preference (`lib/composer-prefs.ts`);
   — Schedule from the send menu, the same door `/schedule` opens;
   — Clear, which puts back the box, the parked pastes and the attachments in
     one go, from the "+" menu.

   Everything about what a *send* is — the empty rule, the upload gate, the
   draft/pastes/attachments carried back on failure, `beforeSend`, `/schedule`
   interception — is unchanged from the version that lived in thread-view.tsx,
   and the comments on it travelled with it. */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"
import {
  Archive,
  ArrowUp,
  AtSign,
  CalendarClock,
  Camera,
  ChevronDown,
  Code,
  CornerDownLeft,
  History,
  Maximize2,
  Mic,
  Minimize2,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCw,
  Slash,
  Square,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Shortcut } from "@/components/shortcut"
import { ComposerAgents, ComposerTodo, ContextIndicator } from "@/components/composer-status"
import { ComposerAttachments, type AttachmentDelivery } from "@/components/composer-attachments"
import { ComposerHistoryDialog } from "@/components/composer-history-dialog"
import { ComposerQueue } from "@/components/composer-queue"
import { ComposerStrip, ComposerStripItem } from "@/components/composer-strip"
import { DraftConfigPopover, DraftScopeRow } from "@/components/draft-config"
import { SessionConfigPopover } from "@/components/session-config"
import { ThreadToolsMenu } from "@/components/thread-tools"
import { FileMentionMenu, useFileMentions } from "@/components/file-mentions"
import {
  HARNESS_COMMANDS,
  SlashCommandMenu,
  harnessCommandFor,
  useSlashCommands,
} from "@/components/slash-commands"
import { useComposerAttachments } from "@/hooks/use-composer-attachments"
import { useCoarsePointer, useIsMobile } from "@/hooks/use-mobile"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { setComposerPrefs, useComposerPrefs } from "@/lib/composer-prefs"
import type { ComposerHistoryEntry } from "@/lib/composer-history"
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
import { KEYS, formatChord, matchesChord } from "@/lib/shortcuts"
import { bannerFor, composerLock } from "@/lib/thread/phase"
import type { ThreadItem, ThreadState } from "@/lib/store"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/** The strip's scope row, as a caller outside the thread may want it drawn —
    see `DraftScopeRow`. The build page swaps the project half for its own
    starter picker; the agent half is always the agent half. */
export interface ComposerScope {
  hideProject?: boolean
  leading?: React.ReactNode
}

/* Past this the prompt is long enough that its size is worth a reading, and
   the expand toggle is worth a slot on the row. Both are about the same
   question — "is this more than a sentence" — so they share one answer. */
const LONG_PROMPT_CHARS = 240
const LONG_PROMPT_LINES = 3
/* The long-press that opens the send menu on touch. Longer than a tap, shorter
   than the platform's own context menu (which the handler suppresses on the
   button anyway). */
const LONG_PRESS_MS = 450

/** Where the caret is, or the end of the text when the box is not mounted. */
function selectionOf(el: HTMLTextAreaElement | null, fallback: number): [number, number] {
  const start = el?.selectionStart ?? fallback
  const end = el?.selectionEnd ?? start
  return [start, end]
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
  beforeSend,
  scope,
  placeholder,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
  delivery: AttachmentDelivery
  /** Awaited between "the words have been taken" and the send itself; `false`
      (or a throw) puts them back in the box and sends nothing. While it runs
      the send button shows busy. The build page scaffolds the project here. */
  beforeSend?: (text: string) => Promise<boolean>
  scope?: ComposerScope
  /** Overrides the idle placeholder only; the lock and queue notes still win. */
  placeholder?: string
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
  const filePicker = React.useRef<HTMLInputElement>(null)
  const cameraPicker = React.useRef<HTMLInputElement>(null)
  const [reviving, setReviving] = React.useState(false)
  /* `beforeSend` in flight: the box is taken, the button is busy. */
  const [gated, setGated] = React.useState(false)
  /* The taller box. Not persisted: it is about this prompt, not the reader. */
  const [expanded, setExpanded] = React.useState(false)
  const [sendMenuOpen, setSendMenuOpen] = React.useState(false)
  const isMobile = useIsMobile()
  const coarse = useCoarsePointer()
  const prefs = useComposerPrefs()
  // Rebindable in Settings › Keyboard, so it is read rather than named here.
  const steerChords = useChords("steer")
  const historyChords = useChords("historyPrev")
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
  const banner = bannerFor(thread.phase)

  /* One recovery path with three names. Which one a phase offers is decided in
     `failureFor`, beside the close codes it reads: a takeover only needs a
     reattach (the process is alive), the other codes mean the process is gone
     and `session/load` restores the conversation, and a trashed thread needs a
     restore before either. */
  const recover = () => {
    if (!banner?.action) return
    setReviving(true)
    const run =
      banner.action.kind === "restore" ? actions.restoreThread : actions.reconnectThread
    // The connection already writes the failure into the thread; the toast is
    // for the case where the user is looking at the button, not the transcript.
    run(sessionId)
      .catch((err) => reportError(err, banner.action!.busyLabel.replace("…", " failed")))
      .finally(() => setReviving(false))
  }

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
    setExpanded(false)
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
      .send(sessionId, outgoing, { ...opts, attachments, onUnsent })
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
  const harnessCommands = draft ? [] : HARNESS_COMMANDS
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
       opened transcript mounted and a background panel must not grab the caret;
     — never on touch, where focusing raises the keyboard over the screen the
       user has just arrived at.
     After a frame: dockview moves focus itself as it activates a new panel,
     and the later mover wins. */
  const routed = currentThreadId(location.pathname, location.search) === sessionId
  React.useEffect(() => {
    if (!draft || !routed || isMobile) return
    const frame = requestAnimationFrame(() => composerRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [sessionId, draft, routed, isMobile])

  const mentions = useFileMentions({
    text,
    setText,
    projectId: meta?.projectId,
    inputRef: composerRef,
  })

  /* Typing on the user's behalf. Every insertion the "+" menu makes goes
     through here so the caret lands where a typist's would — after the
     snippet, or inside it when `caretAt` says so — by the same slot the `@`
     completer uses (`requestCaret`), because rewriting `text` is a render and
     the caret must be re-applied after it. Focus comes back on the next frame:
     the menu that was clicked took it, and a snippet with no caret to follow
     it is a snippet the user has to click back into. */
  const insert = (snippet: string, caretAt?: number) => {
    const el = composerRef.current
    const [start, end] = selectionOf(el, text.length)
    setText(text.slice(0, start) + snippet + text.slice(end))
    mentions.requestCaret(start + (caretAt ?? snippet.length))
    requestAnimationFrame(() => el?.focus())
  }
  const insertMention = () => {
    const el = composerRef.current
    const [start] = selectionOf(el, text.length)
    const before = text.slice(0, start)
    // A mention is a word: it needs a space before it unless it starts a line.
    insert(before === "" || /\s$/.test(before) ? "@" : " @")
  }
  /* A command is the start of the message, not a word in it: the completer
     reads `^/name`, so the slash goes to the front wherever the caret was. */
  const insertCommand = () => {
    if (text.startsWith("/")) {
      composerRef.current?.focus()
      return
    }
    setText("/" + text)
    mentions.requestCaret(1)
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  /* Fences around the selection, or an empty block with the caret inside. On
     its own line either way: a fence mid-sentence is not a fence. */
  const insertCodeBlock = () => {
    const el = composerRef.current
    const [start, end] = selectionOf(el, text.length)
    const selected = text.slice(start, end)
    const before = text.slice(0, start)
    const lead = before === "" || before.endsWith("\n") ? "" : "\n"
    const open = `${lead}\`\`\`\n`
    const snippet = `${open}${selected}\n\`\`\`\n`
    setText(before + snippet + text.slice(end))
    mentions.requestCaret(start + open.length + selected.length)
    requestAnimationFrame(() => el?.focus())
  }
  /* Everything that would have gone: the words, the parked pastes and the
     files. The persisted copies go with them — a draft cleared here and
     restored by a reload is a draft the user cleared twice. */
  const clearAll = () => {
    setText("")
    setPastes([])
    setExpanded(false)
    clearDraft(sessionId)
    clearPastes(sessionId)
    files.clear()
    requestAnimationFrame(() => composerRef.current?.focus())
  }

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

  /* The long-press that opens the send menu on touch (and the right-click on
     a mouse). Held on a ref so a pointer that leaves the button mid-press
     cancels rather than fires. */
  const pressTimer = React.useRef<number | null>(null)
  /* Set when the press fired: the finger lifting afterwards still delivers a
     click to the button, and that click must not send the message the menu
     was opened to ask about. */
  const pressFired = React.useRef(false)
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
  }
  const startPress = () => {
    cancelPress()
    pressFired.current = false
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      pressFired.current = true
      setSendMenuOpen(true)
    }, LONG_PRESS_MS)
  }
  React.useEffect(() => cancelPress, [])

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
  const iconSize = coarse ? "icon" : "icon-sm"
  const steerChord = formatChord(steerChords[0] ?? "")

  const sendTitle = gated
    ? "Working…"
    : thread.turnActive
      ? `Queue (${steerChord} steers the running turn instead)`
      : "Send"

  return (
    <div className="px-4 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {/* What this device's connection is doing, when it is doing something
          worth interrupting for. A *state*, not a transcript row: the ladder
          used to append an error when it gave up, and giving up is exactly the
          condition that ends on its own — so the row stayed in the middle of
          the conversation, one per outage, describing something that was over. */}
      {banner && (
        <div
          className={cn(
            "mx-auto mb-1.5 flex w-full max-w-[var(--harness-composer-width)] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-center text-xs",
            banner.tone === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <span>
            <span className="font-medium">{banner.title}</span> {banner.message}
          </span>
          {banner.action && (
            <Button size="lg" variant="outline" onClick={recover} disabled={reviving}>
              <RotateCw className={cn("size-4", reviving && "animate-spin")} />
              {reviving ? banner.action.busyLabel : banner.action.label}
            </Button>
          )}
        </div>
      )}
      <ComposerStrip>
        {/* Read from the journal, with no agent behind it. Said rather than
            enforced: the composer stays live because sending is what revives
            the thread (see actions.send), and a box you cannot type into would
            make the user go looking for a button to press first. */}
        {thread.archived && (
          <ComposerStripItem
            summary={{ id: "archived", icon: Archive, label: "Agent not running" }}
            className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground"
          >
            <Archive className="size-3 shrink-0" />
            <span>This thread's agent isn't running. Sending a message starts it again.</span>
          </ComposerStripItem>
        )}
        {/* Where it runs and who answers, before either is settled. They belong
            on the shelf rather than in the settings menu: picking a different
            agent changes what every option under it even means, and a thread
            started in the wrong project is started in the wrong directory. */}
        {draft && meta && (
          <ComposerStripItem>
            {/* Registers its own summary — the names it prints are the ones it
                already looks up. */}
            <DraftScopeRow
              meta={meta}
              actions={actions}
              hideProject={scope?.hideProject}
              leading={scope?.leading}
            />
          </ComposerStripItem>
        )}
        {/* The agent's checklist when it arrives as a tool call rather than an
            ACP plan. The ACP plan itself is NOT here: it is a running account of
            the work, so it belongs in the transcript with the work — the shelf
            keeps the list a runtime sends as tool input, which has nowhere else
            to go. */}
        <ComposerTodo thread={thread} />
        {/* How many subagents are out working, while any are. */}
        <ComposerAgents thread={thread} />
        {/* What is waiting for this turn to end. The user's own words, so
            they are editable in place until the moment they go. */}
        <ComposerQueue sessionId={sessionId} thread={thread} actions={actions} />
        {/* What is riding along with the message but is not in the box: a long
            paste parked behind a token, a file. */}
        <ComposerAttachments
          pastes={shownPastes}
          attachments={files.attachments}
          delivery={delivery}
          onRemovePaste={removePaste}
          onRemoveAttachment={files.remove}
          onRetryAttachment={files.retry}
        />
        {/* Says what the box is showing and how to get back out of it — without
            it, a recalled prompt is indistinguishable from one you typed. */}
        {history.browsing && (
          <ComposerStripItem
            summary={{ id: "history", icon: History, label: "Earlier prompt" }}
            className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground"
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
          Deliberately no focus ring: the caret in the textarea is the "you are
          typing here" signal, and the card stays quiet otherwise. The one ring
          it wears is destructive, and only while voice is listening.

          It is also the drop target, and deliberately the whole card rather
          than the textarea: a file aimed at "the composer" lands on the button
          row or the padding as often as on the box. `dragCounter` is what makes
          the overlay stable — `dragleave` fires as the pointer crosses into a
          child, so a boolean would flicker the whole way across. */}
      <div
        data-expanded={expanded || undefined}
        className={cn(
          "relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl bg-composer p-2 shadow-lg",
          "ring-1 ring-transparent transition-[ring-color] duration-200",
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
          onKeyDown={(e) => {
            // The command menu owns navigation keys (and Enter) while open.
            if (slash.onKeyDown(e)) return
            // Then the `@` menu, for the same reason.
            if (mentions.onKeyDown(e)) return
            if (history.onKeyDown(e)) return
            if (e.key !== "Enter") return
            /* Past the queue: into the turn that is already running. Checked
               first because it is the more specific chord, and it is every
               Cmd/Ctrl+Enter now — with no turn running `send({steer})` is an
               ordinary send, so the chord never has to be told apart from the
               plain one by the person pressing it. It is also the send key
               when Enter has been set to break the line. */
            if (steerChords.some((chord) => matchesChord(e, chord))) {
              e.preventDefault()
              void send({ steer: true })
              return
            }
            /* Bare Enter sends on desktop and inserts a newline on touch, where
               Return is the only newline key there is and every soft keyboard
               shows it as one. Shift+Enter is the desktop escape hatch — and
               with `enterSends` off the two swap: Enter breaks the line and
               nothing but the chord above or the button sends. IME composition
               is left alone — Enter is how you accept a candidate. */
            if (isMobile || e.altKey || e.nativeEvent.isComposing) return
            if (!prefs.enterSends) return
            if (e.shiftKey) return
            e.preventDefault()
            void send()
          }}
          aria-label="Message the agent"
          placeholder={
            lock.note ??
            (voice.listening && !text
              ? "Listening…"
              : thread.turnActive
                ? "Queue a message for when the agent finishes…"
                : (placeholder ?? "Message the agent…"))
          }
          disabled={disabled || gated}
          rows={1}
          className={cn(
            "min-h-9 w-full resize-none border-0 bg-transparent px-2 py-1.5 leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent",
            /* Folded, the box grows to ten lines and then scrolls. Expanded it
               takes most of the panel — `--panel-h` inside the dock, the
               viewport outside it — and half of a phone, where the soft
               keyboard already has the other half. */
            expanded
              ? "max-h-[calc(var(--panel-h,100svh)*0.55)] min-h-40 sm:max-h-[calc(var(--panel-h,100svh)*0.6)]"
              : "max-h-40"
          )}
        />
        {/* One control language across the row: every button is the same
            size (32px on a mouse, 36px on a finger — `iconSize`), rounded-lg,
            and chrome-less with a hover wash. The row sits INSIDE the composer
            card, so a bordered button there is a box inside a box; colour
            carries the meaning instead, and only on the two that act on the
            message as a whole: Send is a filled primary disc, Stop a
            destructive one. */}
        <div className="flex items-center gap-1 pt-1">
          {/* What goes in. One menu holds every way of adding to the message
              — the row used to give each its own button, and on a phone that
              row was the first thing to overflow. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size={iconSize}
                  className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                  disabled={disabled || gated}
                  title="Add to the message"
                />
              }
            >
              <Plus />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-52">
              <DropdownMenuItem onClick={() => filePicker.current?.click()}>
                <Paperclip />
                Attach files
              </DropdownMenuItem>
              {/* The camera is a touch thing: a laptop's webcam is not what
                  "take a photo" means, and the picker on a desktop already
                  opens the file dialog. */}
              {coarse && (
                <DropdownMenuItem onClick={() => cameraPicker.current?.click()}>
                  <Camera />
                  Take a photo
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {meta?.projectId && (
                <DropdownMenuItem onClick={insertMention}>
                  <AtSign />
                  Mention a file
                  <DropdownMenuShortcut>@</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {hasCommands && (
                <DropdownMenuItem onClick={insertCommand}>
                  <Slash />
                  Run a command
                  <DropdownMenuShortcut>/</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={insertCodeBlock}>
                <Code />
                Insert code block
              </DropdownMenuItem>
              {/* The browsable half of the prompt history — Up is the other,
                  and both walk the same global list. Offered only once there
                  is something in it, so a fresh install is not given a door
                  onto an empty room. */}
              {composerHistory.items.length > 0 && (
                <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                  <History />
                  Earlier prompt
                  <DropdownMenuShortcut>{formatChord(historyChords[0] ?? "")}</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {hasContent && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={clearAll}>
                    <Trash2 />
                    Clear message
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The pickers. Two, because `capture` is an attribute and not a
              mode: an input with it goes straight to the camera and skips the
              gallery, which is right for "take a photo" and wrong for
              "attach". Cleared after each pick, or choosing the same file twice
              fires no change event. */}
          <input
            ref={filePicker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) files.add(e.target.files)
              e.target.value = ""
            }}
          />
          <input
            ref={cameraPicker}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) files.add(e.target.files)
              e.target.value = ""
            }}
          />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Before the session exists the profile catalog is the only thing
                that knows the choices; after it, the agent is. Two controls,
                one slot — see CLAUDE.md's rule about which owns the model. */}
            {draft && meta ? (
              <DraftConfigPopover meta={meta} actions={actions} />
            ) : (
              <>
                <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} />
                {/* The kit picked on the draft, still said once the thread is
                    running: the links were written at create and are what a
                    revive spawns with, so this is a read-out rather than the
                    picker the strip carried. It draws nothing when the thread
                    carries no tools. */}
                {meta && (
                  <ThreadToolsMenu
                    meta={meta}
                    actions={actions}
                    editable={false}
                    /* The strip's own dimensions are the strip's; in the
                       composer row it wears the same 32px, chrome-less shape
                       as the config trigger beside it. */
                    className="h-8 gap-1.5 px-2 text-xs hover:bg-transparent hover:text-foreground data-popup-open:bg-transparent"
                  />
                )}
              </>
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
          <ContextIndicator thread={thread} meta={meta} actions={actions} />
          {/* The taller box. Offered once the prompt is more than a sentence,
              and kept while it is open so it can be closed. */}
          {(long || expanded) && (
            <Button
              variant="ghost"
              size={iconSize}
              className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              onClick={() => {
                setExpanded((v) => !v)
                requestAnimationFrame(() => composerRef.current?.focus())
              }}
              title={expanded ? "Shrink the box" : "Expand the box"}
              aria-pressed={expanded}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
          {voice.supported && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-lg text-muted-foreground hover:text-foreground",
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
              so the toggle has to be there to take it off. */}
          {thread.canPause && (thread.turnActive || thread.paused) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "shrink-0 rounded-lg text-muted-foreground hover:text-foreground",
                thread.paused && "text-primary hover:text-primary"
              )}
              onClick={() =>
                (thread.paused ? actions.resume(sessionId) : actions.pause(sessionId)).catch((err) =>
                  reportError(err, thread.paused ? "Couldn't resume the turn" : "Couldn't pause the turn")
                )
              }
              title={thread.paused ? "Resume" : "Pause at the next step"}
            >
              {thread.paused ? <Play /> : <Pause />}
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="ghost"
              size={iconSize}
              className="shrink-0 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => actions.stop(sessionId).catch(() => {})}
              title="Stop"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          {/* How it goes. The chevron is the visible door; a long-press on
              Send (touch) and a right-click (mouse) open the same menu, so the
              options are reachable from the button itself. It is hidden on a
              draft with nothing running and nothing to schedule — then the
              menu would hold only the Enter preference, which is not worth a
              control on every new thread's row. */}
          <DropdownMenu open={sendMenuOpen} onOpenChange={setSendMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "-mr-0.5 shrink-0 rounded-lg text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
                    coarse && "size-8"
                  )}
                  title="Send options"
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-60">
              {/* The label is Base UI's Menu.GroupLabel: it reads its group from
                  context and throws outside one, so it sits inside the group it
                  heads rather than loose in the content. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {thread.turnActive ? "A turn is running" : "Send"}
                </DropdownMenuLabel>
                {thread.turnActive ? (
                  <>
                    <DropdownMenuItem disabled={!canSend} onClick={() => void send()}>
                      <ArrowUp />
                      Queue for when it finishes
                      {!isMobile && prefs.enterSends && <DropdownMenuShortcut>⏎</DropdownMenuShortcut>}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canSend} onClick={() => void send({ steer: true })}>
                      <CornerDownLeft />
                      Steer the running turn
                      {!isMobile && <DropdownMenuShortcut>{steerChord}</DropdownMenuShortcut>}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled={!canSend} onClick={() => void send()}>
                    <ArrowUp />
                    Send now
                    {!isMobile && (
                      <DropdownMenuShortcut>{prefs.enterSends ? "⏎" : steerChord}</DropdownMenuShortcut>
                    )}
                  </DropdownMenuItem>
                )}
                {/* The same door `/schedule` opens, for the hand that did not
                    know the command. A draft cannot be scheduled against — the
                    server does not know it yet. */}
                {!draft && (
                  <DropdownMenuItem disabled={!text.trim()} onClick={() => openSchedule(text.trim())}>
                    <CalendarClock />
                    Schedule…
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              {/* Moot on touch, where Return is always a newline. */}
              {!isMobile && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={prefs.enterSends}
                    onCheckedChange={(checked) => setComposerPrefs({ enterSends: checked })}
                    closeOnClick={false}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span>Enter sends</span>
                      <span className="text-xs text-muted-foreground">
                        {prefs.enterSends
                          ? "Shift+Enter breaks the line"
                          : `Off — Enter breaks the line, ${steerChord} sends`}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="default"
            size={iconSize}
            className="shrink-0 rounded-full shadow-sm disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
            onClick={() => {
              if (pressFired.current) {
                pressFired.current = false
                return
              }
              void send()
            }}
            onPointerDown={(e) => {
              if (e.pointerType === "touch") startPress()
            }}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => {
              e.preventDefault()
              cancelPress()
              setSendMenuOpen(true)
            }}
            disabled={!canSend}
            title={sendTitle}
            aria-label={sendTitle}
          >
            {gated ? <Spinner className="size-4" /> : <ArrowUp className="size-4.5" strokeWidth={2.5} />}
          </Button>
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

/* ── Prompt history ──
   Up recalls what you have already sent, the way a shell recalls a command.

   The history used to BE the transcript — every user turn of the thread you
   were standing in. That made it per-thread, which is the one thing a prompt
   history must not be: the hand that types is the same in every thread, and so
   is the phrase it keeps re-typing. It is the server's list now
   (`lib/composer-history.ts`), global across every thread and every device on
   this connection, oldest last exactly as before.

   Up still answers on the keystroke, because the list it walks is the query
   cache's — persisted to localStorage per server, so it is in hand before the
   first read lands — and a send patches that cache itself rather than waiting
   for a re-read. Walking back stashes whatever was half-typed; Escape, and
   walking forward off the end, put it back. */
function usePromptHistory(entries: ComposerHistoryEntry[], setText: (text: string) => void) {
  /* The server answers newest-first (the order the history page lists in) and
     the walk wants oldest-first, so Up from the bottom is the last thing sent.
     Keyed on the array identity the cache hands out, which only changes when
     the list actually does. */
  const history = React.useMemo(
    () => entries.map((entry) => entry.text).reverse(),
    [entries]
  )
  /** null = not browsing. Otherwise an index into `history`. */
  const [index, setIndex] = React.useState<number | null>(null)
  const stash = React.useRef("")

  // Sending (or a replay landing) changes the list under the cursor, so the
  // walk is over — the index would point at a different prompt than it did.
  React.useEffect(() => setIndex(null), [history.length])

  const apply = (el: HTMLTextAreaElement, value: string) => {
    setText(value)
    // The caret belongs at the end of the recalled prompt — after React has put
    // it in the DOM, which is the next frame.
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length))
  }

  /** True when it consumed the event, matching the slash menu's contract. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = event.currentTarget
    if (matchesChord(event, KEYS.escape)) {
      if (index === null) return false
      setIndex(null)
      apply(el, stash.current)
      /* Stop it reaching the thread's Escape, which would read this as "stop the
         turn" — leaving the history is the more local meaning and wins. */
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (history.length === 0) return false

    if (matchesChord(event, KEYS.historyPrev)) {
      /* Only from the very start of the box. Anywhere else Up is a caret move,
         which is what the key is for while editing a long prompt. */
      if (index === null && !(el.selectionStart === 0 && el.selectionEnd === 0)) return false
      const next = index === null ? history.length - 1 : index - 1
      event.preventDefault()
      // At the oldest prompt: stay there rather than falling out of the walk.
      if (next < 0) return true
      if (index === null) stash.current = el.value
      setIndex(next)
      apply(el, history[next])
      return true
    }

    if (matchesChord(event, KEYS.historyNext)) {
      if (index === null) return false
      event.preventDefault()
      const next = index + 1
      if (next >= history.length) {
        setIndex(null)
        apply(el, stash.current)
      } else {
        setIndex(next)
        apply(el, history[next])
      }
      return true
    }
    return false
  }

  return { onKeyDown, browsing: index !== null }
}

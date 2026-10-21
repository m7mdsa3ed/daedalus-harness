/* ── Composer ──
   The box, the shelf above it and the toolbar beneath. One component for every
   surface that takes a prompt.

   ── The card is three bands ──
   **The scope band on top** — where this thread runs, what it carries, how full
   its window is, and whether this device can get a message out about it:
   project · connection · tools · … · the context ring. It is the band that does
   not change when the thread starts. Both halves used to be draft-only rows on
   the shelf, which meant the project vanished at the moment it started
   mattering: while you were typing the *first* message you could see which
   directory the agent would edit, and from the second message on you could not.
   A started thread's project is fixed (it is the cwd) so it reads out rather
   than picks, and the tools menu already knew how to do both. The connection
   sits directly after it, because the two are the questions the rest of the
   floor is read against — and because it is the one reading whose answer the
   shelf's own ground then wears (`tone` below). The ring at the end is the same
   `ContextIndicator` the tab wears, opening upward.

   **The textarea.** **Then one toolbar** that reads left to right as *what goes
   in → who answers → what happens*: the "+" menu (attach, photo, mention,
   command, code block), the model/config cluster, then the counters and the
   actions, ending on a filled Send. Every control on the row is the same shape,
   and the three that act on the whole message wear a filled ground instead of a
   border: the "+" muted, Send primary, Stop destructive. The scale follows the
   pointer — 24px (`icon-xs`) under a
   mouse, 32px (`icon-sm`) under a finger, where the same row had to double as a
   touch target (`useCoarsePointer`, see below).

   Nothing else is in the card. The shelf above it (`ComposerStrip`) holds every
   *state you consult while typing* — the queue, the checklist, the running
   subagents, attachments, pastes — and it tucks its bottom edge behind the
   scope band, so what is transient stacks above what is permanent.

   What used to be five separate buttons (attach, voice, pause, stop, send)
   competing for a row that is 300px wide on a phone is now a menu on the left
   and the actions on the right. The "+" holds everything that *adds to* the
   message; Send is always drawn — a muted disabled chip while the box is empty,
   a filled primary disc the moment there is something to send — with the mic
   beside it while the box is empty and Stop beside it while a turn runs. Queue
   and steer are still the two sends (⏎ and the steer chord), said in Send's
   tooltip rather than in a menu.

   Features the toolbar offers beyond the old row:
   — a length reading once a prompt is long enough for its size to matter,
     with a rough token estimate (4 chars ≈ 1 token — an estimate, said as one);
   — camera capture on touch (`capture="environment"` on a second picker);
   — Clear, which puts back the box, the parked pastes and the attachments in
     one go, from the "+" menu.

   Everything about what a *send* is — the empty rule, the upload gate, the
   draft/pastes/attachments carried back on failure, `beforeSend`, `/automate`
   interception — is unchanged from the version that lived in thread-view.tsx,
   and the comments on it travelled with it.

   ── What lives beside this file ──
   The card and its two rows are here, because the rule is about the two of
   them together. The pieces that are a subject of their own are not:
   `add-menu.tsx` (the "+", and the pickers only it clicks),
   `text-insertions.ts` (what that menu types on the user's behalf),
   `enhance-button.tsx` (the rewrite and every read behind it), `keys.ts` (the
   one ordering of Enter and the completers), `prompt-history.ts` (the Up
   walk). Nothing about the *connection* is here at all — it is a `Notice` at
   the foot of the transcript (`components/thread-view/thread-status.tsx`). */
import type * as acp from "@daedalus/acp"
import * as React from "react"
import { useLocation, useNavigate } from "react-router"
import {
  ArrowUp,
  AudioLines,
  ChevronDown,
  Maximize2,
  MessageSquareText,
  Mic,
  Minimize2,
  Pause,
  PhoneOff,
  Play,
  Square,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { McpPicker } from "@/components/composer/mcp-picker"
import { KEY_MARK } from "@/components/composer/indicator"
import { optionKey, useAgentCommands } from "@/lib/agent-options"
import {
  AgentsIndicator,
  AutomationsIndicator,
  ChangesIndicator,
  ContextIndicator,
  RepoIndicator,
  TodoIndicator,
} from "@/components/composer-status"
import { ComposerAttachments, type AttachmentDelivery } from "@/components/composer-attachments"
import { ComposerEditor, type TextSurface } from "@/components/composer/composer-editor"
import { quoteLines } from "@/components/composer/editor-text"
import { ComposerStrip } from "@/components/composer-strip"
import { ComposerAddMenu } from "@/components/composer/add-menu"
import { EnhanceButton } from "@/components/composer/enhance-button"
import { composerKeyDown } from "@/components/composer/keys"
import { usePromptHistory } from "@/components/composer/prompt-history"
import { PromptHistoryWalk } from "@/components/composer/history-menu"
import { selectionOf, textInsertions } from "@/components/composer/text-insertions"
import { DraftScopeRow } from "@/components/draft-config"
import { ConfigPopover } from "@/components/session-config"
import { FileMentionMenu, useFileMentions } from "@/components/file-mentions"
import {
  HARNESS_COMMANDS,
  SlashCommandMenu,
  harnessCommandFor,
  useSlashCommands,
} from "@/components/slash-commands"
import { ProjectCommandMenu, shellLineFor, useProjectCommands } from "@/components/project-commands"
import { useFimCompletion } from "@/components/composer/fim-completion"
import { threadRecap } from "@/lib/thread/recap"
import { useComposerAttachments } from "@/hooks/use-composer-attachments"
import { useCoarsePointer, useIsMobile } from "@/hooks/use-device"
import { useVoice } from "@/hooks/use-voice"
import { useAgents, useCommands, useProfiles } from "@/lib/queries/catalog"
import { defaultVoice, useVoiceProviders, voiceFor } from "@/lib/queries/voice"
import { endVoiceCall, startVoiceCall, useVoiceCallActive } from "@/lib/voice-call"
import type { Actions } from "@/lib/actions"
import { useComposerPrefs } from "@/lib/composer-prefs"
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
import { consumeComposerFocusRequest, useComposerFocusRequest } from "@/lib/composer-focus"
import { consumeComposerInsertRequest, useComposerInsertRequest } from "@/lib/composer-insert"
import { reportError } from "@/lib/errors"
import { withTaskContext } from "@/lib/tasks-board"
import { HARNESS_MCP_ID, splitTaskContext } from "@/lib/task-mentions"
import { mcpPromptCommands, mcpPromptFor, readMcpResourceFile, renderMcpPrompt } from "@/lib/mcp-composer"
import { useServer } from "@/lib/server-context"
import { useChords } from "@/lib/keybindings"
import { useShortcut } from "@/hooks/use-hotkey"
import {
  clearPastes,
  expandPastes,
  isLongPaste,
  livePastes,
  loadPastes,
  mintPaste,
  pasteToken,
  savePastes,
  type Paste,
} from "@/lib/pastes"
import {
  useComposerHistory,
  useInvalidateShellHistory,
  useProjectScripts,
  useProjects,
  useRecordComposerHistory,
  useShellHistory,
  useThreadMcp,
} from "@/lib/queries"
import { currentThreadId, newAutomationPath } from "@/lib/router"
import type { SessionMeta } from "@/lib/settings"
import { formatChord } from "@/lib/shortcuts"
import { composerLock } from "@/lib/thread/phase"
import type { ThreadState } from "@/lib/store"
import type { TurnChanges } from "@/lib/workspace/git-api"
import { holdOf } from "@/lib/thread/hold"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/* Lazy: the realtime providers ride this chunk, so a composer with no call
   never pays for them. */
const VoiceCall = React.lazy(() => import("@/components/thread-view/voice-call"))

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
  /** Add an excerpt under what is typed as `> ` lines — drawn in the box as a
      quote card — caret on the line after it. The transcript's "Ask about this". */
  quote(excerpt: string): void
}

/* Memoized: `ThreadView` re-renders on every streamed token, and the
   composer — the Tiptap editor, the indicators, the menus — was re-rendered
   with it on the urgent pass, holding the *old* deferred thread, before its
   own low-priority pass with the new one. Every prop it is handed is stable
   between tokens, so the urgent pass now skips it. */
export const Composer = React.memo(function Composer({
  sessionId,
  actions,
  thread,
  meta,
  /* Resolved by ThreadView and handed down: the transcript's error rows read
     the same answer (see `wentInline`), and two `useAttachmentDelivery` calls
     in one tree would be two subscriptions to the same absolute state. */
  delivery,
  changes,
  onSend,
  beforeSend,
  placeholder,
  autoFocus,
  collapsed = false,
  voiceCall = false,
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
  /** Fired as a message goes out — the transcript uses it to follow to the end. */
  onSend?: () => void
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
  /** The reader has scrolled away from the tail of the transcript, so the box
      rides down out of the way until they come back to it. Read off the
      scroller's own pin by `ThreadView` (`useFollowStream`), never state of this
      component's own, so it is the same fact the scroll-to-end button draws.
      The reserved height stays (`--composer-dock-h`): collapsing must not
      re-flow the transcript under somebody who is reading it. */
  collapsed?: boolean
  /** Offer the voice call. Wherever it is offered, something has to draw the
      call card with it — a thread view at the transcript's foot, the landing
      console above its box (`landing-page.tsx`). */
  voiceCall?: boolean
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
  const expandingTasks = React.useRef(false)
  const composerRef = React.useRef<TextSurface>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [editorOverflows, setEditorOverflows] = React.useState(false)
  const onEditorOverflowChange = React.useCallback((overflowing: boolean) => {
    setEditorOverflows(overflowing)
  }, [])
  /* Words put in the box from outside it — a suggested follow-up, a queued row's
     Edit, an "Ask about this", the enhancer's rewrite — have to be *seen*, so a
     fill while the box is scrolled away re-opens it. Handed back to the scroll
     the moment the reader is at the tail again, which is the state the pin was
     clean in; the box is an overlay, so re-opening one moves nothing. */
  const [revealed, setRevealed] = React.useState(false)
  React.useEffect(() => {
    if (!collapsed) setRevealed(false)
  }, [collapsed])
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
  /* Voice mode, beside dictation: offered once a backend is set up. A draft may
     start one — the call buffers its lines until the first send makes the row. */
  const voiceBackend = defaultVoice(useVoiceProviders().data)
  const inCall = useVoiceCallActive(sessionId)
  /* The thread's MCP servers, read by the harness's own client: their prompts
     join the `/` menu and their resources the `@` one, for every runtime. */
  const server = useServer()
  /* The call's backend: project, then profile, then default — the order the
     server resolves `?sessionId=` in, decided once here so the bar and the
     token it connects with agree on which one they are using. */
  const voiceProvider = voiceFor(
    useVoiceProviders().data,
    useProjects().find((p) => p.id === meta?.projectId)?.defaults?.voiceProvider,
    useProfiles().find((p) => p.id === meta?.profileId)?.voiceProvider
  )
  const mcpServers = useThreadMcp(sessionId, !draft)
  const lock = composerLock(thread.phase, draft)
  const disabled = !lock.typable

  /* The automation form, pinned to this thread and pre-filled: `/automate`
     typed into the box. The text goes to the form expanded (the form stores it
     on the server, where the sidecar a token points into does not exist) and
     the draft is deliberately NOT cleared, because nothing has been sent and
     the form is a place you can back out of. */
  const openAutomation = (message: string) => {
    void navigate(newAutomationPath(sessionId), {
      state: {
        defaultText: expandPastes(message, pastes),
        returnTo: location.pathname + location.search,
      },
    })
  }

  /* The draft is cleared optimistically: a failure leaves a transcript row that
     carries the exact text and a Retry button, which is a better home for it
     than a textarea the user has since typed into.

     `/automate` is intercepted here rather than sent: it is the harness's own
     command (see slash-commands.tsx), so its text opens the automation form
     pre-filled instead of reaching the agent. */
  /* The prompt history is the server's and global (lib/composer-history): what
     Up walks, and what the history page lists. Read here so a recall is served
     from the cache rather than a round trip. */
  const composerHistory = useComposerHistory()
  const recordHistory = useRecordComposerHistory()

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
    /* An MCP prompt is rendered by its server and put in the box, not sent:
       the words are the server's, and the person reads them before the agent
       does. The line stays if the server fails, so nothing typed is lost. */
    const mcpPrompt = draft ? null : mcpPromptFor(value, mcpServers, thread.availableCommands)
    if (mcpPrompt) {
      void renderMcpPrompt(server, sessionId, mcpPrompt.server.id, mcpPrompt.prompt.name, mcpPrompt.args)
        .then((rendered) => {
          if (rendered) setText(rendered)
          else reportError(new Error("the prompt came back empty"), `Couldn't render /${mcpPrompt.server.name}:${mcpPrompt.prompt.name}`)
        })
        .catch((err) => reportError(err, `Couldn't render /${mcpPrompt.server.name}:${mcpPrompt.prompt.name}`))
      return
    }
    const command = draft ? null : harnessCommandFor(value, thread.availableCommands)
    if (command?.name === "automate") {
      openAutomation(command.args)
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
    /* A `!` line is run against the project and written into the transcript —
       it is not a prompt, so the agent never sees it. On a started thread it is
       journaled; on a draft it is drawn locally and nothing is saved, so the
       draft stays a draft (`actions.runShell`). */
    const line = draft && !meta?.projectId ? null : shellLineFor(value)
    if (line) {
      void runProjectCommand(line)
      return
    }
    /* The tokens become their bodies here, at the last moment, exactly as
       `mentions.ts` derives resource links from the text at the last moment.
       Everything downstream sees the string it always did. */
    let outgoing = expandPastes(value, pastes)
    /* A task mention brings the task along, appended the way a paste's body
       is — only where the agent has the Harness MCP the block tells it to use
       (`lib/task-mentions.ts`). Read before the box clears, so a failed read
       leaves the words where they were; and once, however often Enter lands. */
    if (meta?.mcpServerIds?.includes(HARNESS_MCP_ID)) {
      if (expandingTasks.current) return
      expandingTasks.current = true
      try {
        outgoing = await withTaskContext(server, outgoing)
      } catch (err) {
        reportError(err, "Couldn't read the mentioned task")
        return
      } finally {
        expandingTasks.current = false
      }
    } else {
      outgoing = splitTaskContext(outgoing).text
    }
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
    onSend?.()
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
  const history = usePromptHistory(composerHistory.items, setText, composerRef)

  /* Running an agent command is just sending `/name args` as the prompt — the
     agent resolves it — so the menu only completes the name. Drafts advertise
     no commands (no process yet); they are also offered no harness commands,
     because `/automate` needs a thread the server knows about to schedule
     against, which a draft is not until its first message. */
  /* A draft has no process, so it is offered none of these. `/compact` is
     dropped again where the runtime does not take the request — offering a
     command that can only answer "this agent decides for itself" is worse than
     not offering it. */
  const harnessCommands = React.useMemo(
    () =>
      draft
        ? []
        : [
            ...HARNESS_COMMANDS.filter((c) => c.name !== "compact" || thread.canCompact),
            ...mcpPromptCommands(mcpServers),
          ],
    [draft, thread.canCompact, mcpServers],
  )
  /* A draft has no process to advertise anything, so it is offered what the
     spawn will materialise (the library commands it has picked, where its
     runtime reads commands out of the workspace at all) plus the catalog the
     option probe's throwaway session advertised — built-ins, user skills,
     plugins. The thread that follows replaces both with its own
     `available_commands_update`. */
  const libraryCommands = useCommands()
  const agents = useAgents()
  const probedCommands = useAgentCommands(
    meta ? optionKey(meta.profileId, meta.agentId) : "",
    meta ? [optionKey(`default:${meta.agentId}`, meta.agentId)] : []
  )
  const draftCommands = React.useMemo((): acp.AvailableCommand[] => {
    if (!draft) return []
    const agent = agents.find((a) => a.id === meta?.agentId)
    const picked = new Set(meta?.commandIds ?? [])
    const own =
      agent && !agent.workspaceLayout?.commands
        ? []
        : libraryCommands
            .filter((c) => picked.has(c.id))
            .map((c) => ({
              name: c.name,
              description: c.description,
              ...(c.argumentHint ? { input: { hint: c.argumentHint } } : {}),
            }))
    // What the probe's session advertised, minus a name the picks already say.
    const taken = new Set(own.map((c) => c.name))
    return [...own, ...probedCommands.filter((c) => !taken.has(c.name))]
  }, [draft, agents, meta?.agentId, meta?.commandIds, libraryCommands, probedCommands])
  const agentCommands = draft ? draftCommands : thread.availableCommands
  const slash = useSlashCommands(text, agentCommands, setText, harnessCommands)
  const hasCommands = agentCommands.length > 0 || harnessCommands.length > 0

  /* `!` suggests the project's saved shell lines and the scripts its
     package.json files declare. A project command is not a prompt: `send`
     above runs the line it names against the project and writes the result
     into the transcript, so nothing travels to the agent. The helper rows
     ride on `useProjects()` — the server folds a project's helpers into its
     list — and the script rows on one query per project. A draft is offered
     them too: its line runs without a journal and leaves the draft a draft. */
  const projects = useProjects()
  const project = meta?.projectId
    ? projects.find((candidate) => candidate.id === meta.projectId)
    : undefined
  const helpers = project?.helpers ?? []
  const scripts = useProjectScripts(meta?.projectId ?? "", Boolean(meta?.projectId)).data ?? []
  /* Plus what has already been run here — a routine is re-run far more often
     than it is written, and the server's tally is what puts the daily line at
     the top of the menu. The server's, not this device's: the line you build
     with belongs to the workspace, so the phone offers what the desktop ran. */
  const shellHistory =
    useShellHistory(meta?.projectId ?? "", Boolean(meta?.projectId)).data ?? []
  const invalidateShellHistory = useInvalidateShellHistory()
  const commands = useProjectCommands({ text, helpers, scripts, history: shellHistory, setText })
  /* The line runs in the project and its output lands in the transcript as a
     `_daedalus/shell` row — no turn, no prompt. Which directory and environment
     it runs in is not the client's to decide: the server resolves a line that
     IS one of the saved commands back to its helper (so a helper's own cwd and
     env still apply, whether the line was picked or typed), and runs anything
     else in the project root. */
  const runProjectCommand = (line: string) => {
    /* Send and forget, exactly as a prompt is: the row the running line
       already draws IS the feedback, and `runShell` settles it itself —
       including on failure, whose error row is the thing to read, not a box
       still holding the line. */
    setText("")
    clearDraft(sessionId)
    void actions
      .runShell(sessionId, line, draft ? meta?.projectId : undefined)
      .catch((err) => {
        reportError(err, `Couldn't run ${line}`)
      })
      /* The server counted the run; this is the cache catching up, so the
         next `!` already has the line at the top. Whether it failed is not
         the tally's business — a line that failed is one you are about to
         run again with a flag fixed. */
      .finally(() => {
        if (meta?.projectId) invalidateShellHistory(meta.projectId)
      })
  }

  /* `@` offers paths and thread resources alongside draft MCP servers.
     It reads the token at the caret — a file is named mid-sentence,
     unlike a command — so the textarea has to be reachable. It goes after the
     command menu in the key handler: whichever menu is open owns the arrows. */

  /* Draft threads take the caret when routed, and explicit palette requests
     can take it for an existing thread the user chose to open. Scoped to the
     routed thread so a background dock tab never grabs the caret. After a frame,
     dockview has finished activating its panel. */
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
  /* Only the composer in front of you answers the call chord, like the
     pickers' keys: a background tab's composer must not start a call. */
  const voiceChord = formatChord(useChords("voiceCall")[0] ?? "")
  useShortcut(
    "voiceCall",
    () => {
      if (inCall) return endVoiceCall(sessionId)
      startVoiceCall(sessionId)
    },
    { enabled: Boolean(voiceBackend && voiceCall && (routed || autoFocus)) }
  )
  const focusRequest = useComposerFocusRequest(sessionId)
  React.useEffect(() => {
    if (!(routed || autoFocus)) return
    if (focusRequest !== 0 && isMobile) {
      consumeComposerFocusRequest(sessionId, focusRequest)
      return
    }
    if (isMobile || (!draft && focusRequest === 0)) return
    const frame = requestAnimationFrame(() => {
      if (focusRequest !== 0) consumeComposerFocusRequest(sessionId, focusRequest)
      composerRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionId, draft, routed, autoFocus, isMobile, focusRequest])

  const mentions = useFileMentions({
    text,
    setText,
    projectId: meta?.projectId,
    inputRef: composerRef,
    mcpServers,
    draft,
    linkedMcpServerIds: meta?.mcpServerIds,
    onResource: (resource) => {
      readMcpResourceFile(server, sessionId, resource.serverId, resource.uri, resource.name)
        .then((file) => files.add([file]))
        .catch((err) => reportError(err, `Couldn't read ${resource.uri}`))
    },
    onMcpServer: (picked) => {
      if (!meta?.draft) return
      const selected = new Set(meta.mcpServerIds ?? [])
      selected.add(picked.id)
      actions.configureDraft(meta.id, { mcpServerIds: [...selected] })
    },
  })

  /* The completion lane's ghost text (fim-completion.ts). Both callbacks are
     memoised because the hook debounces on their identity — a fresh function
     every render would re-arm the timer forever. */
  const fimCaret = React.useCallback(() => {
    const surface = composerRef.current
    if (!surface) return null
    /* A selection is not a place to fill: the gap would replace text the reader
       chose, which is an edit, not a suggestion. */
    return surface.selectionStart === surface.selectionEnd ? surface.selectionStart : null
  }, [])
  const fimInsert = React.useCallback(
    (gap: string, at: number) => {
      const current = textRef.current
      const next = current.slice(0, at) + gap + current.slice(at)
      setText(next)
      mentions.requestCaret(at + gap.length)
      return next
    },
    [mentions.requestCaret, setText]
  )
  /* What the thread has said, so a gap can be finished as a *reply*: capped and
     cheap (`thread/recap.ts`), and it only moves when the conversation does. */
  const fimContext = React.useMemo(() => threadRecap(thread.items), [thread.items])
  const fim = useFimCompletion({
    text,
    caret: fimCaret,
    insert: fimInsert,
    enabled: !disabled,
    context: fimContext,
  })

  const { insertMention, insertCommand, insertProjectCommand, insertCodeBlock } = textInsertions({
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
      setRevealed(true)
      setText(prompt)
      mentions.requestCaret(prompt.length)
      requestAnimationFrame(() => composerRef.current?.focus())
    },
    [mentions.requestCaret]
  )
  React.useImperativeHandle(
    ref,
    () => ({
      fill: applySuggestion,
      isEmpty: () => text.trim() === "",
      quote: (excerpt) => {
        const typed = text.replace(/\s+$/, "")
        applySuggestion(`${typed ? `${typed}\n\n` : ""}${quoteLines(excerpt.trim())}\n\n`)
      },
    }),
    [applySuggestion, text]
  )

  /* Text handed in from outside the transcript — the Preview's "Pick element" —
     added *under* what is typed rather than replacing it, the way a quote is.
     Consumed by revision, so a request never lands twice. */
  const insertRequest = useComposerInsertRequest(sessionId)
  React.useEffect(() => {
    if (!insertRequest) return
    consumeComposerInsertRequest(sessionId, insertRequest.revision)
    setRevealed(true)
    const typed = textRef.current.replace(/\s+$/, "")
    const next = typed ? `${typed}\n\n${insertRequest.text}` : insertRequest.text
    setText(next)
    mentions.requestCaret(next.length)
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [sessionId, insertRequest, mentions.requestCaret])

  /* A long paste is parked rather than pasted: the token goes in at the caret
     and the body waits in the sidecar until send. Below the threshold nothing
     happens at all — the affordance has to be invisible for the pastes people
     actually make (a URL, an error line, a name).

     The caret is the same hazard `file-mentions.tsx` documents: rewriting
     `text` is a render, and the caret it wants has to be re-applied *after*
     that render and ahead of the sync from `selectionStart`. So it goes through
     that hook's own slot rather than a second mechanism racing it. */
  const onPaste = (event: ClipboardEvent): boolean => {
    /* Files BEFORE text: a screenshot on the clipboard usually carries a
       text/plain fallback too, and reading text first would turn every
       screenshot paste into an empty chip. */
    const pastedFiles = [...(event.clipboardData?.files ?? [])]
    if (pastedFiles.length > 0) {
      event.preventDefault()
      files.add(pastedFiles)
      return true
    }
    const plain = event.clipboardData?.getData("text/plain")
    if (!plain) return false
    /* A short paste carrying a link is taken too, so the URL becomes the same
       chip a typed one does — ProseMirror's input rules never see a paste. It
       goes through `setText`, which reparses into the box's link atoms, and the
       caret is re-applied after the render (`file-mentions.tsx`'s slot). */
    if (!isLongPaste(plain) && /https?:\/\//i.test(plain)) {
      event.preventDefault()
      const el = composerRef.current
      const [start, end] = selectionOf(el, text.length)
      mentions.requestCaret(start + plain.length)
      setText(text.slice(0, start) + plain + text.slice(end))
      return true
    }
    if (!isLongPaste(plain)) return false
    event.preventDefault()
    const el = composerRef.current
    const [start, end] = selectionOf(el, text.length)
    const paste = mintPaste(pastes, plain)
    const token = pasteToken(paste.n)
    setPastes([...pastes, paste])
    mentions.requestCaret(start + token.length)
    setText(text.slice(0, start) + token + text.slice(end))
    return true
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
  /* The row's one scale, the Button's own: `icon-xs` (24px) under a mouse,
     `icon-sm` (32px) under a finger. Every icon button in the composer takes
     it, so the row is one size and one language. */
  const iconSize = coarse ? "icon-sm" : "icon-xs"
  const steerChord = formatChord(steerChords[0] ?? "")

  const sendTitle = gated
    ? "Working…"
    : hold.paused
      ? hold.sendHint
      : thread.turnActive
        ? `Queue (${steerChord} steers the running turn instead)`
        : "Send"

  /* Away only while the scroll says so and nothing has just been put in the box
     — see `revealed` above. */
  const away = (collapsed && !revealed) || inCall

  return (
    /* Collapsed: the reader has left the tail, so the shelf rides down out of
       the way and the card morphs into a pill — a transform, an opacity and a
       clip, never `hidden`, so the height it reserves for the transcript
       (measured off this element as `--composer-dock-h`) does not move and the
       words being read stay put. `inert` too, or the box would keep the caret
       and the tab order while it is clipped away. What brings it back is the
       reader's own gesture: the pill, reaching the bottom (which re-pins the
       scroller, `useFollowStream`), or the scroll-to-end button. */
    <div
      data-composer-away={away || undefined}
      className={cn(
        "relative px-4 pt-1 pb-[max(0.75rem,var(--safe-bottom))]",
        away ? "pointer-events-none" : "pointer-events-auto"
      )}
    >
      {/* Away, the card morphs into this pill (its clip-path below shrinks onto
          exactly this box), and a click is the reader asking for the box back:
          the same `revealed` a fill sets, handed back to the scroll at the tail.
          In a call the box is away for good and the pill is the way out of it:
          it ends the call, which gives the box back. */}
      <button
        type="button"
        tabIndex={away ? 0 : -1}
        aria-hidden={!away || undefined}
        aria-label={inCall ? "End voice call" : "Message the agent"}
        title={inCall ? `End voice call${voiceChord ? ` (${voiceChord})` : ""}` : text.trim() || "Message the agent"}
        onClick={() => {
          if (inCall) return endVoiceCall(sessionId)
          setRevealed(true)
          requestAnimationFrame(() => composerRef.current?.focus())
        }}
        className={cn(
          "composer-pill absolute bottom-[max(0.75rem,var(--safe-bottom))] right-[max(1rem,calc((100%_-_var(--harness-composer-width))/2))] z-20",
          "transition-opacity duration-300 ease-out motion-reduce:transition-none",
          away ? "pointer-events-auto opacity-100 delay-100" : "pointer-events-none opacity-0"
        )}
      >
        {inCall ? (
          <PhoneOff className="size-4 shrink-0 text-destructive" />
        ) : (
          <MessageSquareText className="size-4 shrink-0" />
        )}
      </button>
      {/* The call's controls, beside the pill that ends it: the box is away
          for the whole call, so this is where it is run from. Mounted here,
          not in the transcript, so a call belongs to the composer it replaces. */}
      {inCall && voiceProvider && (
        <div className="pointer-events-auto absolute bottom-[max(0.75rem,var(--safe-bottom))] right-[calc(max(1rem,calc((100%_-_var(--harness-composer-width))/2))_+_var(--composer-pill)_+_0.5rem)] z-20">
          <React.Suspense fallback={null}>
            <VoiceCall
              sessionId={sessionId}
              thread={thread}
              actions={actions}
              settings={server}
              provider={voiceProvider}
              draft={draft}
            />
          </React.Suspense>
        </div>
      )}
      <ComposerStrip
        aria-hidden={away || undefined}
        inert={away || undefined}
        className={cn(
          "transition-[translate,opacity] duration-300 ease-out motion-reduce:transition-none",
          away && "translate-y-6 opacity-0"
        )}
        /* ── The scope row ──
           Where this thread runs, what it carries, how full it is — the shelf's
           floor, under whatever the turn has put on it. It survives the first
           message: the row is the same either side of it, only the project
           stops being a choice. The ring is here rather than on the send row
           because context occupancy is a fact about the thread, not a control.
           Nothing without a `meta`, which is a thread the server has not
           answered for yet.

           The connection is not here. It was a reading on this row, and for a
           while the one whose tone the shelf's whole ground wore; a dead
           connection is a sentence with a button rather than a number glanced
           at, so it is a `Notice` at the foot of the transcript with the other
           things the thread is doing (`ThreadStatus`). */
        footer={
          meta && (
            <DraftScopeRow
              meta={meta}
              actions={actions}
              editable={draft}
              showSelectedMcps={false}
              keys={routed || autoFocus}
              /* The readings, in one cluster at the row's end: how far the
                 checklist has got, how many workers are out, what the last turn
                 wrote, how full the window is. Four answers of the same *kind*
                 — one number that is true of the thread right now, glanced at
                 constantly and read in full rarely — so they are one shape (a
                 24px trigger over a popover) in one place, rather than a card on
                 a shelf each. Every one of them draws nothing when it has
                 nothing to say, so an idle thread's cluster is the ring alone. */
              trailing={
                <>
                  <TodoIndicator thread={thread} />
                  <AgentsIndicator thread={thread} />
                  {!draft && <AutomationsIndicator sessionId={sessionId} />}
                  <ChangesIndicator changes={changes} />
                  <RepoIndicator meta={meta} />
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
        {/* Says what the box is showing and how to get back out of it — without
            it, a recalled prompt is indistinguishable from one you typed. */}
        {history.browsing && history.index !== null && (
          <PromptHistoryWalk rows={history.rows} selected={history.index} onSelect={history.select} />
        )}
        {/* Last on the shelf, nearest the composer: these suggestions are about
            the text being typed right now, where everything above belongs to
            the turn. It is a row, not an overlay, so the plan and the history
            notice stay readable while you complete a command. */}
        <SlashCommandMenu state={slash} />
        <ProjectCommandMenu state={commands} projectId={meta?.projectId ?? undefined} />
        <FileMentionMenu state={mentions} />
      </ComposerStrip>
      {/* relative/z-10: the composer paints over the strip's tucked bottom edge.
          It draws no edge and no focus ring: the composer's own ground meeting
          the page is the seam, like the shelf above it. Its only ring is
          destructive, while voice is listening.

          It is also the drop target, and deliberately the whole card rather
          than the textarea: a file aimed at "the composer" lands on the button
          row or the padding as often as on the box. `dragCounter` is what makes
          the overlay stable — `dragleave` fires as the pointer crosses into a
          child, so a boolean would flicker the whole way across. */}
      <div
        data-slot="composer-card"
        aria-hidden={away || undefined}
        inert={away || undefined}
        className={cn(
          "relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-composer p-composer-pad",
          /* The morph: clipped down to the pill's box (`--composer-pill` square,
             bottom right) while away. Open is a negative inset, not `none`, so the
             two shapes interpolate. A
             clip moves no layout, so `--composer-dock-h` holds. The pill
             corner uses the theme's pill radius, so square themes stay square. */
          "transition-[clip-path,ring-color] duration-300 ease-out motion-reduce:transition-none",
          "[&>*]:transition-opacity [&>*]:duration-200",
          away
            ? "[clip-path:inset(calc(100%_-_var(--composer-pill))_0_0_calc(100%_-_var(--composer-pill))_round_var(--app-radius-pill))] [&>*]:opacity-0"
            : "[clip-path:inset(-5rem)]",
          /* The composer's ground (theme glass, the recipe `Card` wears). */
          "bg-composer-glass backdrop-blur-[var(--app-blur)] backdrop-saturate-[calc(1.3*var(--app-saturate))]",
          voice.listening && "ring-1 ring-destructive/40"
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
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-composer border-2 border-dashed border-primary bg-composer-glass text-sm font-medium text-primary">
            Drop to attach
          </div>
        )}
        {/* The prompt enhancer, in the card's top-right corner: it acts on
            the words in the box, so it sits with them rather than in the row
            of controls about sending. It rewrites the draft through the AI SDK
            against the profile picked in Settings › General — a device habit,
            not a property of the thread. */}
        <div className={cn("absolute right-composer-pad z-10", coarse ? "top-[calc(var(--spacing-composer-pad)+0.125rem)]" : "top-[calc(var(--spacing-composer-pad)+0.375rem)]")}>
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
        </div>
        <ComposerEditor
          ref={composerRef}
          value={text}
          onChange={setText}
          onSelect={mentions.onSelect}
          onPaste={onPaste}
          pastes={shownPastes}
          ghost={fim.ghost}
          pending={fim.pending}
          onOverflowChange={onEditorOverflowChange}
          expanded={expanded}
          coarse={coarse}
          onKeyDown={composerKeyDown({
            slash,
            commands,
            completion: fim,
            mentions,
            history,
            isMobile,
            enterSends: prefs.enterSends,
            steerChords,
            send,
          })}
          ariaLabel="Message the agent"
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
          className={cn(
            /* Same reading size as the transcript's messages: the card carries
               the `--text-sm` bump `.thread-transcript` sets, so typing matches
               what is being answered. */
            "w-full text-sm md:text-sm",
            /* Clear of the enhance button in the corner. */
            coarse ? "pr-8" : "pr-6",
            /* Keep the compact default, with more room available on demand. */
            expanded ? "max-h-[min(50vh,32rem)]" : "max-h-40",
            /* Roomier under a thumb: the caret row leading its 32px buttons
               is how the row stays visually centred while the targets grow. */
            coarse && "[&_.tiptap]:min-h-11"
          )}
        />
        {/* One control language across the row: every icon button is the
            Button's own `iconSize` — idle ones ghost, Send `default`, Stop
            `destructive` — so the row is stock variants only. */}
        <div
          data-slot="composer-toolbar"
          className={cn("flex items-center gap-1 pt-1", coarse && "gap-2 pt-2")}
        >
          <ComposerAddMenu
            disabled={disabled || gated}
            size={iconSize}
            coarse={coarse}
            onFiles={files.add}
            onLibraryFile={files.addFromLibrary}
            canMention={Boolean(meta?.projectId)}
            hasCommands={hasCommands}
            hasProjectCommands={helpers.length > 0 || scripts.length > 0}
            hasHistory={composerHistory.items.length > 0}
            hasContent={hasContent}
            onMention={insertMention}
            onCommand={insertCommand}
            onProjectCommand={insertProjectCommand}
            onCodeBlock={insertCodeBlock}
            /* Picking replaces the box rather than appending: this is "recall
               that prompt", the same act Up performs. */
            onHistory={(picked) => {
              setText(picked)
              requestAnimationFrame(() => {
                const el = composerRef.current
                if (!el) return
                el.focus()
                el.setSelectionRange(el.value.length, el.value.length)
              })
            }}
            onClear={clearAll}
          />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Who answers. */}
            {/* `keys`: Alt+M / Alt+S open these from anywhere in the thread in
                front — the menus are already arrow/typeahead/Space driven. */}
            {meta && (
              <ConfigPopover meta={meta} sessionId={sessionId} actions={actions} thread={thread} keys={routed || autoFocus} />
            )}
            {/* The MCPs it will carry, read and picked here beside the model. */}
            {meta && <McpPicker meta={meta} actions={actions} keys={routed || autoFocus} />}
          </div>
          {/* The completion lane at work. It sits in this row rather than over
              the text because nothing about it is positioned: it is a fact about
              the box, like the length. A failure takes the same slot for one
              line — silence there reads as "the feature is off", which is the
              wrong conclusion to draw from a bad key. Either clears on the next
              keystroke, and the full words are in the title. */}
          {/* Only the failure takes this row: "asking" is drawn at the caret
              itself (`ComposerEditor`), which is where the reader is looking. A
              failure has no line to sit on, so it says its one word here, with
              the server's own message in the title. */}
          {fim.status.kind === "failed" && (
            <span
              className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground"
              aria-live="polite"
              title={fim.status.error ?? "The completion lane did not answer"}
            >
              <TriangleAlert className="size-3 text-destructive" />
              <span className="hidden @panel-sm:inline">No completion</span>
            </span>
          )}
          {/* How long the prompt is, once that is worth knowing. The token
              figure is an estimate and is printed as one (the tilde); it is
              there so a pasted document reads as "about 3k tokens" before it
              is sent, not after. Only where the row has room for words. */}
          {long && (
            <span
              className="hidden shrink-0 px-1 text-xs tabular-nums text-muted-foreground @panel-sm:inline"
              title={`${chars.toLocaleString()} characters, ${lines} lines — roughly ${formatTokens(Math.ceil(chars / 4))} tokens`}
            >
              {formatTokens(chars)} · ~{formatTokens(Math.ceil(chars / 4))} tok
            </span>
          )}
          {(editorOverflows || expanded) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "text-muted-foreground",
                expanded && "text-primary hover:text-primary"
              )}
              onClick={() => setExpanded((current) => !current)}
              title={expanded ? "Collapse composer" : "Expand composer"}
              aria-label={expanded ? "Collapse composer" : "Expand composer"}
              aria-pressed={expanded}
            >
              {expanded ? <Minimize2 className={KEY_MARK} /> : <Maximize2 className={KEY_MARK} />}
            </Button>
          )}
          {voice.supported && (voice.listening || (!hasContent && !gated)) && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "text-muted-foreground",
                // Listening is a live state, so it stays coloured — but as text,
                // not as a filled chip that reintroduces the chrome.
                voice.listening && "animate-pulse text-destructive hover:text-destructive"
              )}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title={voice.listening ? "Stop listening" : "Voice input"}
              aria-pressed={voice.listening}
            >
              <Mic className={KEY_MARK} />
            </Button>
          )}
          {voiceBackend && voiceCall && (
            <Button
              variant="ghost"
              size={iconSize}
              className={cn(
                "text-muted-foreground",
                inCall && "text-primary hover:text-primary"
              )}
              onClick={() => (inCall ? endVoiceCall(sessionId) : startVoiceCall(sessionId))}
              title={voiceChord ? `${inCall ? "End voice call" : "Voice call"} (${voiceChord})` : inCall ? "End voice call" : "Voice call"}
              aria-pressed={inCall}
            >
              <AudioLines className={KEY_MARK} />
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
                "text-muted-foreground",
                thread.paused && "text-primary hover:text-primary"
              )}
              onClick={() =>
                /* Resume records its own failure in the thread (a toast would
                   be the second telling); pause records nothing, so it toasts. */
                thread.paused
                  ? actions.resume(sessionId).catch(() => {})
                  : actions.pause(sessionId).catch((err) => reportError(err, "Couldn't pause the turn"))
              }
              title={
                hold.byError
                  ? "Continue — change the model first if the same one will fail again"
                  : hold.paused
                    ? "Resume"
                    : "Pause at the next step"
              }
            >
              {thread.paused ? <Play className={KEY_MARK} /> : <Pause className={KEY_MARK} />}
            </Button>
          )}
          {thread.turnActive && (
            <Button
              variant="destructive"
              size={iconSize}
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
              <Square className="size-3 fill-current" />
            </Button>
          )}
          {/* Always drawn, even on an empty box: the affordance you aim at
              stays in the same place before and after you type, rather than
              appearing the moment the first character lands. When there is
              nothing to send `canSend` is false and it wears the stock disabled
              look. Like the "+", it is round and the same size. */}
          <Button
            size={iconSize}
            onClick={() => void send()}
            disabled={!canSend}
            loading={gated}
            title={sendTitle}
            aria-label={sendTitle}
          >
            {gated ? <Spinner className={KEY_MARK} /> : <ArrowUp className={KEY_MARK} strokeWidth={2.5} />}
          </Button>
        </div>
      </div>
    </div>
  )
})

import * as React from "react"
import { ArrowUp, Clock, History, Mic, RotateCw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  ActivityIndicator,
  ComposerPlan,
  ComposerTodo,
  ContextIndicator,
} from "@/components/composer-status"
import { ComposerApproval } from "@/components/composer-approval"
import { ComposerStrip, ComposerStripItem } from "@/components/composer-strip"
import { Textarea } from "@/components/ui/textarea"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useIsMobile } from "@/hooks/use-mobile"
import { useHotkey } from "@/hooks/use-hotkey"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
import { reportError } from "@/lib/errors"
import { currentThreadId, schedulePath } from "@/lib/router"
import type { SessionMeta } from "@/lib/settings"
import { KEYS, isInteractiveTarget, isTypingTarget, matchesChord, overlayOpen } from "@/lib/shortcuts"
import { useStore, emptyThread, threadIsEmpty, type ThreadItem, type ThreadState } from "@/lib/store"
import { useLocation, useNavigate } from "react-router"
import { useViewOptions, ViewOptionsContext } from "@/lib/view-options"
import { cn } from "@/lib/utils"
import { DraftConfigPopover, DraftScopeRow } from "./draft-config"
import { SessionConfigPopover } from "./session-config"
import { SlashCommandMenu, useSlashCommands } from "./slash-commands"
import { SessionSettingsButton } from "./session-settings"
import { InlineElicitation } from "./elicitation-form"
import { primaryPermissionOption } from "./composer-approval"
import { ThreadItemView, ToolRun, type ToolRunGroup } from "./thread-items"
import { ThreadRail } from "./thread-rail"

/** Consecutive tool steps become one ToolRunGroup; everything else passes
    through untouched. Runs of one stay ungrouped — a lone step wrapped in a
    "1 step" disclosure is strictly worse than the step. */
function groupToolRuns(items: ThreadItem[]): (ThreadItem | ToolRunGroup)[] {
  const rows: (ThreadItem | ToolRunGroup)[] = []
  let run: Extract<ThreadItem, { kind: "tool" }>[] = []

  const flush = () => {
    if (run.length > 1) rows.push({ id: `tools-${run[0].id}`, items: run })
    else rows.push(...run)
    run = []
  }

  for (const item of items) {
    if (item.kind === "tool") run.push(item)
    else {
      flush()
      rows.push(item)
    }
  }
  flush()
  return rows
}

/* ── Thread keys ──
   Escape, and the digits that answer a pending question, for the transcript the
   URL points at — the dock can have several mounted at once and only one of
   them is the one being looked at, so these are gated rather than bound per
   card. Priority is the order the screen reads: a question the agent is blocked
   on outranks a permission, which outranks the turn still running.

   Escape is deliberately live while the composer has focus. It does nothing in
   a textarea, and "skip this and move on" is a thing you want to do without
   taking your hands off the keys. The digits are not: a bare 1 belongs to
   whatever you are typing. */
function useThreadKeys({
  sessionId,
  thread,
  actions,
  enabled,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
  enabled: boolean
}) {
  const { permission, elicitation, turnActive } = thread

  useHotkey(
    KEYS.escape,
    (event) => {
      // A dialog, menu or popup is open — that Escape is its own.
      if (overlayOpen()) return
      if (elicitation) {
        /* `decline` is a real answer, not an abort: the AskUserQuestion bridges
           read it as "the user skipped" and the turn carries on. See
           lib/elicitation. */
        event.preventDefault()
        elicitation.resolve({ action: "decline" })
        return
      }
      if (permission) {
        // Only if the agent offered a no. Nothing is assumed on its behalf.
        const reject = permission.request.options.find((option) =>
          option.kind.startsWith("reject")
        )
        if (!reject) return
        event.preventDefault()
        permission.resolve({ outcome: { outcome: "selected", optionId: reject.optionId } })
        return
      }
      if (turnActive) {
        event.preventDefault()
        actions.stop(sessionId).catch((err) => reportError(err, "Couldn't stop the turn"))
      }
    },
    { enabled }
  )

  useHotkey(
    OPTION_DIGITS,
    (event) => {
      if (!permission || isTypingTarget(event.target) || overlayOpen()) return
      const option = permission.request.options[Number(event.key) - 1]
      if (!option) return
      event.preventDefault()
      permission.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
    },
    { enabled: enabled && !!permission }
  )

  useHotkey(
    "enter",
    (event) => {
      if (!permission || isTypingTarget(event.target) || overlayOpen()) return
      // A focused button answers for itself — Enter must not also answer for it.
      if (isInteractiveTarget(event.target)) return
      // The same narrow yes the card gives the primary button to.
      const optionId = primaryPermissionOption(permission.request.options)
      if (!optionId) return
      event.preventDefault()
      permission.resolve({ outcome: { outcome: "selected", optionId } })
    },
    { enabled: enabled && !!permission }
  )
}

const OPTION_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

export function ThreadView({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  const { state, dispatch } = useStore()
  const thread = state.threads[sessionId] ?? emptyThread
  /* An interrupt is resumable only while it is the last thing that happened:
     the turn is over, the agent is still there, and nothing has been said
     since. Anything older is history, and history does not get a button. */
  const options = useViewOptions(sessionId)
  /* Memoised separately: `.filter` would hand `rows` a fresh array every render
     even when nothing changed, and `rows`' memo depends on it. Two stable layers
     (items → visible → rows) is what lets a streaming update — which mutates one
     item in place via the reducer's new-array-of-old-refs — leave every unchanged
     row's identity alone so the memo below actually skips them. */
  const visible = React.useMemo(
    () => thread.items.filter((item) => item.kind !== "plan"),
    [thread.items]
  )
  /* Grouping folds a *run* of steps into one row. It is computed here, not in
     the reducer: it is a way of looking at the transcript, not a change to it,
     and toggling it must not touch a single item. */
  const rows = React.useMemo(
    () => (options.groupTools ? groupToolRuns(visible) : visible),
    [options.groupTools, visible]
  )
  const last = visible[visible.length - 1]
  const resumable =
    last?.kind === "notice" && !thread.turnActive && thread.status !== "closed"
      ? last.id
      : null
  /* actions.send records its own failure in the transcript (with the text, so
     the row it leaves behind can offer Retry) — a toast on top would say the
     same thing twice. */
  const resume = () => void actions.send(sessionId, "Continue.").catch(() => {})
  const retry = (text: string) => void actions.send(sessionId, text).catch(() => {})
  const checkpoints = React.useMemo(
    () => new Map(thread.history.checkpoints.map((checkpoint) => [checkpoint.turnId, checkpoint])),
    [thread.history.checkpoints]
  )
  const firstUserForTurn = React.useMemo(() => {
    const first = new Map<string, string>()
    for (const item of thread.items) {
      if (item.kind === "user" && item.turnId && !first.has(item.turnId)) first.set(item.turnId, item.id)
    }
    return first
  }, [thread.items])

  const meta = state.sessions.find((s) => s.id === sessionId)
  /* Which transcript the keys belong to. The dock keeps every opened thread
     mounted and navigates the URL as tabs are activated (see workspace/dock), so
     the route is the app's own answer to "which one is in front". */
  const location = useLocation()
  useThreadKeys({
    sessionId,
    thread,
    actions,
    enabled: currentThreadId(location.pathname, location.search) === sessionId,
  })
  // Shared with the hero behind the whole inset, which the shell paints — the
  // two must agree about when this thread counts as empty. See lib/store.
  const empty = threadIsEmpty(thread, meta?.draft)

  return (
    /* Rows: transcript | composer | spacer. The spacer is 1fr while the thread
       is empty and 0fr once it is not, which centres the composer and then
       docks it — `fr` interpolates, so that whole move is one transition on one
       property with nothing measured in JS.
       minmax(0,…) on both flexible tracks, never a bare `1fr`: that is shorthand
       for minmax(auto,1fr), whose auto minimum lets a long transcript push the
       row taller than the thread and scroll the whole pane. */
    <div
      data-empty={empty || undefined}
      className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,0fr)] transition-[grid-template-rows] duration-500 ease-out data-empty:grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]"
    >
      {/* `autoScroll` defaults to FALSE — without it the transcript never follows
           the stream. Every direct child of Content must be an Item with a
           `messageId`: the visibility/preservation scanner skips elements without
           one, so unkeyed items are invisible to the scroller. */}
      <MessageScrollerProvider autoScroll={options.autoScroll}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <ViewOptionsContext.Provider value={options}>
            <MessageScrollerContent
              data-density={options.compactDensity ? "compact" : undefined}
              data-wrap={options.codeWrap ? "on" : undefined}
              className={cn(
                "mx-auto w-full gap-0.5 px-4 py-4",
                options.compactDensity && "gap-0 py-2",
                options.wideTranscript ? "max-w-[82rem]" : "max-w-[var(--harness-chat-width)]",
              )}
            >
              {/* Nothing stands in while a thread connects. A skeleton claimed a
                  shape for content nobody had seen yet, and on a thread that
                  turns out to be empty it was a lie twice over. The sidebar row
                  says "connecting" instead — see AppShell.
                  The empty state is not in here either: it sits with the
                  composer in the middle row, so the greeting and the box you
                  type into travel to the bottom together. */}
              {thread.status === "connecting" && (
                <MessageScrollerItem messageId="starting">
                  <StartingLine draft={meta?.draft} />
                </MessageScrollerItem>
              )}
              {rows.map((row, i) => {
                /* A hairline above each of your messages (except the first)
                    separates one turn from the next when Turn dividers is on. */
                const isUser = !("items" in row) && row.kind === "user"
                const firstUser = rows.findIndex(
                  (r) => !("items" in r) && r.kind === "user",
                )
                const divider = options.stepDividers && isUser && i !== firstUser
                const checkpoint = !("items" in row) && row.kind === "user" && row.turnId && firstUserForTurn.get(row.turnId) === row.id
                  ? checkpoints.get(row.turnId)
                  : undefined
                return (
                /* ponytail: no scrollAnchor. Anchoring the user's message to
                    the top of the viewport meant sending scrolled the whole
                    transcript up and left a blank screen until the agent
                    produced enough output to fill it back in. Autoscroll alone
                    keeps the newest content in view without the jump. */
                /* data-settled gates content-visibility (see index.css). It is
                    set only while a turn is NOT streaming: content-visibility
                    lays off-screen items out at a placeholder, so scrollHeight
                    is only trustworthy when nothing is about to grow — and
                    autoscroll reads scrollHeight. With autoScroll engaged
                    (turnActive) every row stays fully measured; a quiet thread
                    can then bound its DOM for the off-screen bulk. */
                <MessageScrollerItem
                  key={row.id}
                  messageId={row.id}
                  data-settled={!thread.turnActive ? "true" : undefined}
                >
                  {divider && (
                    <div aria-hidden className="my-1.5 h-px bg-border/50 first:hidden" />
                  )}
                  {"items" in row ? (
                    <ToolRun items={row.items} showTimestamps={options.showTimestamps} />
                  ) : (
                    <ThreadItemView
                      item={row}
                      onContinue={resumable === row.id ? resume : undefined}
                      onRetry={
                        row.kind === "error" && row.retryText
                          ? () => retry(row.retryText!)
                          : undefined
                      }
                      onDismiss={
                        row.kind === "error"
                          ? () => dispatch({ type: "dismiss-error", id: sessionId, itemId: row.id })
                          : undefined
                      }
                      onRevert={checkpoint ? () => void actions.revertTurn(sessionId, checkpoint.id) : undefined}
                      revertDisabled={thread.turnActive || thread.history.busy}
                      showTimestamps={options.showTimestamps}
                    />
                  )}
                </MessageScrollerItem>
                )
              })}
              {/* Suppressed while `connecting`: the StartingLine above already
                  owns the wait, and two animated lines over one message read as
                  "we don't know what is happening" rather than as progress.
                  `caught_up` flips the status and hands the wait back here. */}
              {thread.turnActive && thread.status !== "connecting" && (
                <MessageScrollerItem messageId="working">
                  <div className="py-0.5">
                    <ActivityIndicator step={thread.items.length} />
                  </div>
                </MessageScrollerItem>
              )}
              {thread.elicitation && (
                <MessageScrollerItem messageId="elicitation">
                  <div className="py-1">
                    <InlineElicitation elicitation={thread.elicitation} />
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
            </ViewOptionsContext.Provider>
          </MessageScrollerViewport>
          <MessageScrollerButton />
          {/* Inside the Root, not the Viewport: it is an overlay on the
              transcript, and it needs the Provider above it for
              `scrollToMessage`/`currentAnchorId`. It draws nothing under two
              turns, so a short thread pays for it only in a hook call. */}
          {options.turnRail && <ThreadRail items={visible} wide={options.wideTranscript} />}
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="relative">
        {empty && <ThreadWelcome draft={meta?.draft} />}
        <Composer sessionId={sessionId} actions={actions} thread={thread} meta={meta} />
      </div>
      {/* The spacer that collapses. Nothing renders in it — its whole job is to
          be the bottom half of the centring while the thread is empty. */}
      <span aria-hidden />
    </div>
  )
}

/** Sits directly above the composer while a thread is empty, so it travels with
    it rather than being stranded at the top of an empty transcript. */
function ThreadWelcome({ draft }: { draft?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--harness-composer-width)] flex-col items-center gap-1.5 px-4 pb-5 text-center">
      <p className="text-base font-medium">
        {draft ? "What are we working on?" : "Thread ready"}
      </p>
      <p className="max-w-xs text-xs text-balance text-muted-foreground">
        {draft
          ? "Nothing is running yet — the agent starts when you send the first message."
          : "Send the first message — tool calls, plans and thinking stream in here as steps."}
      </p>
    </div>
  )
}

/** The one line a starting thread is allowed to say, staged through the two
    phases the client can actually tell apart: while the draft flag holds, the
    POST that spawns the agent and runs the handshake is in flight; once the
    server's row has replaced it, the socket is attached and replaying the
    journal toward `caught_up`. Distinguishing "spawning" from "stuck" matters
    more than a third fake stage would, so past SLOW_MS the line admits the
    wait rather than shimmering identically forever. */
const SLOW_MS = 6_000

function StartingLine({ draft }: { draft?: boolean }) {
  const [slow, setSlow] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="py-2">
      <div className="harness-shimmer text-xs text-primary">
        {draft ? "Spawning the agent…" : "Connecting…"}
      </div>
      {slow && (
        <div className="pt-1 text-xs text-muted-foreground">
          {draft
            ? "Still starting — the first launch of an agent can take a while."
            : "Still connecting — a long conversation takes a moment to load."}
        </div>
      )}
    </div>
  )
}

/** Close codes the server attaches to the socket (see server/src/sessions.ts):
    4000 killed, 4001 agent exited, 4002 replaced by another connection, 4004 unknown. */
function closedState(code: number | undefined) {
  if (code === 4002)
    return {
      takeover: true,
      message: "This connection was replaced by another device — reconnect to reattach.",
      label: "Reconnect",
      busyLabel: "Reconnecting…",
    }
  return {
    takeover: false,
    message:
      code === 4000 || code === 4004
        ? "This thread is no longer running on the server — the conversation is restored on revive."
        : "The agent process exited — the conversation is restored on revive.",
    label: "Revive",
    busyLabel: "Reviving…",
  }
}

/* ── Prompt history ──
   Up recalls what you have already sent in this thread, the way a shell recalls
   a command. The history IS the transcript — every user turn, oldest last — so
   there is nothing to persist and nothing that can disagree with what is on
   screen above the box. Walking back stashes whatever was half-typed; Escape,
   and walking forward off the end, put it back. */
function usePromptHistory(items: ThreadItem[], setText: (text: string) => void) {
  const history = React.useMemo(
    () => items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])),
    [items]
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

/* The branch label is up to 80 characters of the prompt that made it — often a
   pasted URL, and often with newlines in it. `truncate` alone only helps once
   the row is already at its full width, and a one-line strip row is not the
   place to spend that width: collapse the whitespace and cut it short here, and
   leave the whole thing on `title` for anyone who wants it. */
const BRANCH_LABEL_MAX = 42

function shortLabel(label: string) {
  const flat = label.replace(/\s+/g, " ").trim()
  return flat.length > BRANCH_LABEL_MAX ? `${flat.slice(0, BRANCH_LABEL_MAX - 1)}…` : flat
}

function Composer({
  sessionId,
  actions,
  thread,
  meta,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
}) {
  const navigate = useNavigate()
  const location = useLocation()
  /* The draft lives on this device, per session (lib/drafts). ThreadView is
     keyed by sessionId today so the initializer would be enough — the effect
     keeps it correct if that key ever goes away. */
  const [text, setText] = React.useState(() => loadDraft(sessionId))
  React.useEffect(() => setText(loadDraft(sessionId)), [sessionId])
  React.useEffect(() => saveDraft(sessionId, text), [sessionId, text])
  const [reviving, setReviving] = React.useState(false)
  const isMobile = useIsMobile()
  const voice = useVoice((transcript) => setText((t) => (t ? t + " " : "") + transcript))
  // A draft has no socket, so "closed" never applies to it — it is waiting to be
  // typed into, which is the one state where the composer must stay live.
  const draft = meta?.draft === true
  const disabled = !draft && thread.status === "closed"
  const closed = closedState(thread.closeCode)

  /* Two shapes of dead socket, one recovery path (openThread respawns only when
     the session is actually gone). 4002 only comes from a pre-multiplexing
     server that keeps one socket per thread — the process there is alive, so
     reattaching is enough; the other codes mean the process is gone and ACP
     session/load restores it. */
  const recover = () => {
    setReviving(true)
    const run = closed.takeover ? actions.reconnectThread : actions.reviveThread
    // openThread already writes the failure into the thread; the toast is for
    // the case where the user is looking at the button, not the transcript.
    run(sessionId)
      .catch((err) => reportError(err, closed.busyLabel.replace("…", " failed")))
      .finally(() => setReviving(false))
  }

  /* The draft is cleared optimistically: a failure leaves a transcript row that
     carries the exact text and a Retry button, which is a better home for it
     than a textarea the user has since typed into. */
  const send = () => {
    const value = text.trim()
    if (!value) return
    setText("")
    clearDraft(sessionId)
    void actions.send(sessionId, value).catch(() => {})
  }

  /* Up/Down walk what has already been sent here. It goes after the slash menu
     in the key handler below: while that menu is open the arrows are its. */
  const history = usePromptHistory(thread.items, setText)

  /* Running a command is just sending `/name args` as the prompt — the agent
     resolves it — so the menu only completes the name. Drafts advertise no
     commands (no process yet), which closes the menu on its own. */
  const slash = useSlashCommands(text, thread.availableCommands, setText)

  return (
    <div className="px-4 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {disabled && (
        <div className="mx-auto mb-1.5 flex w-full max-w-[var(--harness-composer-width)] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-center text-xs text-muted-foreground">
          <span>{closed.message}</span>
          <Button size="lg" variant="outline" onClick={recover} disabled={reviving}>
            <RotateCw className={cn("size-4", reviving && "animate-spin")} />
            {reviving ? closed.busyLabel : closed.label}
          </Button>
        </div>
      )}
      <ComposerStrip>
        {thread.history.conflict && (
          <ComposerStripItem className="px-3 py-1.5 text-[11px] text-destructive">
            {thread.history.conflict}
          </ComposerStripItem>
        )}
        {!thread.history.available && thread.items.length > 0 && (
          <ComposerStripItem className="px-3 py-1.5 text-[11px] text-muted-foreground">
            {thread.history.reason ?? "Revert is unavailable for this agent."}
          </ComposerStripItem>
        )}
        {thread.history.branches.map((branch) => (
          <ComposerStripItem key={branch.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
            <History className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={branch.label}>
              Retained: {shortLabel(branch.label)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              disabled={thread.turnActive || thread.history.busy}
              onClick={() => void actions.recoverBranch(sessionId, branch.id)}
            >
              Recover
            </Button>
          </ComposerStripItem>
        ))}
        {/* Where it runs and who answers, before either is settled. They belong
            on the shelf rather than in the settings menu: picking a different
            agent changes what every option under it even means, and a thread
            started in the wrong project is started in the wrong directory. */}
        {draft && meta && (
          <ComposerStripItem>
            <DraftScopeRow meta={meta} actions={actions} />
          </ComposerStripItem>
        )}
        <ComposerPlan thread={thread} />
        {/* The agent's checklist when it arrives as a tool call rather than an
            ACP plan — same surface as the plan, so both are read in place. */}
        <ComposerTodo thread={thread} />
        {/* The one thing the turn is waiting on. Moves here so a reader who has
            scrolled up does not collide with the question mid-history. */}
        <ComposerApproval permission={thread.permission} />
        {/* Says what the box is showing and how to get back out of it — without
            it, a recalled prompt is indistinguishable from one you typed. */}
        {history.browsing && (
          <ComposerStripItem className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
            <History className="size-3" />
            <span>Earlier prompt</span>
            <span className="ms-auto flex items-center gap-1.5">
              <KbdGroup>
                <Kbd>Esc</Kbd>
              </KbdGroup>
              to go back
            </span>
          </ComposerStripItem>
        )}
        {/* Last on the shelf, nearest the composer: these suggestions are about
            the text being typed right now, where everything above belongs to
            the turn. It is a row, not an overlay, so the plan and the history
            notice stay readable while you complete a command. */}
        <SlashCommandMenu state={slash} />
      </ComposerStrip>
      {/* relative/z-10: the composer paints over the strip's tucked bottom edge. */}
      <div className="relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl bg-composer p-2 shadow-glass-lg">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The command menu owns navigation keys (and Enter) while open.
            if (slash.onKeyDown(e)) return
            if (history.onKeyDown(e)) return
            if (e.key !== "Enter") return
            /* Cmd/Ctrl+Enter always sends. Bare Enter sends on desktop and
               inserts a newline on touch, where Return is the only newline key
               there is and every soft keyboard shows it as one. Shift+Enter is
               the desktop escape hatch. IME composition is left alone — Enter
               is how you accept a candidate. */
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault()
              send()
              return
            }
            if (isMobile || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          placeholder={
            disabled
              ? "Session ended"
              : thread.turnActive
                ? "Steer the agent…"
                : "Message the agent…"
          }
          disabled={disabled}
          rows={1}
          className="max-h-40 min-h-9 w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {/* One control language across the row: every button is icon-sm (32px,
            the height the model/config trigger already sets), rounded-lg, and
            chrome-less — no resting border or fill, only a hover wash. The row
            sits INSIDE the composer card, so a bordered button there is a box
            inside a box; colour carries the meaning instead (primary sends,
            destructive stops). */}
        <div className="flex items-center gap-1 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Before the session exists the profile catalog is the only thing
                that knows the choices; after it, the agent is. Two controls,
                one slot — see CLAUDE.md's rule about which owns the model. */}
            {draft && meta ? (
              <DraftConfigPopover meta={meta} actions={actions} />
            ) : (
              <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} />
            )}
            <SessionSettingsButton sessionId={sessionId} />
          </div>
          <ContextIndicator thread={thread} />
          {voice.supported && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "shrink-0 rounded-lg",
                // Listening is a live state, so it stays coloured — but as text,
                // not as a filled chip that reintroduces the chrome.
                voice.listening && "animate-pulse text-destructive hover:text-destructive"
              )}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              disabled={disabled}
              title="Voice input"
            >
              <Mic />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-lg"
            onClick={() => void navigate(schedulePath(sessionId), {
              state: { defaultText: text, returnTo: location.pathname + location.search },
            })}
            disabled={disabled}
            title="Schedule a message"
          >
            <Clock />
          </Button>
          {thread.turnActive && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-lg text-destructive hover:text-destructive"
              onClick={() => actions.stop(sessionId).catch(() => {})}
              title="Stop"
            >
              <Square />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-lg text-primary hover:text-primary disabled:text-muted-foreground"
            onClick={send}
            disabled={disabled || !text.trim()}
            title={thread.turnActive ? "Send steering message" : "Send"}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  )
}

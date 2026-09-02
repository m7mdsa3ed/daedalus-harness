import * as React from "react"
import type * as acp from "@daedalus/acp"
import { Archive, ArrowUp, ChevronUp, History, Mic, Paperclip, RotateCw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Shortcut } from "@/components/shortcut"
import {
  ActivityIndicator,
  ComposerAgents,
  ComposerTodo,
  ContextIndicator,
} from "@/components/composer-status"
import {
  ComposerAttachments,
  useAttachmentDelivery,
  wentInline,
  type AttachmentDelivery,
} from "@/components/composer-attachments"
import { ComposerQueue } from "@/components/composer-queue"
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
import { useComposerAttachments } from "@/hooks/use-composer-attachments"
import { useIsMobile } from "@/hooks/use-mobile"
import { useHotkey } from "@/hooks/use-hotkey"
import { useChords } from "@/lib/keybindings"
import { useVoice } from "@/hooks/use-voice"
import type { Actions } from "@/lib/actions"
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
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
import { reportError } from "@/lib/errors"
import {
  bannerFor,
  composerLock,
  slowLine,
  startingLine,
  type ConnPhase,
} from "@/lib/thread/phase"
import { currentThreadId, schedulePath } from "@/lib/router"
import type { SessionMeta } from "@/lib/settings"
import { KEYS, formatChord, isInteractiveTarget, isTypingTarget, matchesChord, overlayOpen } from "@/lib/shortcuts"
import { useDispatch, useSessionMeta, useThread, threadIsEmpty, type ThreadItem, type ThreadState } from "@/lib/store"
import { useLocation, useNavigate } from "react-router"
import { useViewOptions, ViewOptionsContext } from "@/lib/view-options"
import { useFollowStream } from "@/hooks/use-follow-stream"
import { cn } from "@/lib/utils"
import { DraftConfigPopover, DraftScopeRow } from "./draft-config"
import { SessionConfigPopover } from "./session-config"
import { ThreadToolsMenu } from "./thread-tools"
import { FileMentionMenu, useFileMentions } from "./file-mentions"
import { HARNESS_COMMANDS, SlashCommandMenu, harnessCommandFor, useSlashCommands } from "./slash-commands"
import { StepTokensProvider, TokenSummary } from "./token-usage"
import { InlineElicitation } from "./elicitation-form"
import { InlineApproval, primaryPermissionOption } from "./tool-approval"
import { RowView, SourcesStrip } from "./thread-items"
import { splitTurns, turnSources, type TurnSources } from "@/lib/sources"
import { buildRows, isAnswerItem, rowTailId, type Row } from "@/lib/transcript-rows"
import { ThreadRail } from "./thread-rail"

/**
 * Append a Sources row to every finished turn that has any. Computed on the
 * transcript rather than in the reducer for the same reason grouping is: it is
 * a reading of the items, derived entirely from what is already there, and it
 * must not change one. The last turn only qualifies once it has ended — a
 * strip that grows while the answer is still streaming is noise under the
 * cursor — so `turnActive` is part of the input.
 */
/* A finished turn is immutable — items are append-only and a changed item is a
   new object — so its extraction (JSON-parsing every tool's rawOutput and
   regex-scanning every message) is done once and remembered against the turn's
   first item. Only the last, unfinished turn ever changes, and it is skipped
   while `turnActive` anyway, so a streamed token now costs O(1 turn) instead
   of O(thread). Keyed on the item *object* in a WeakMap: a replay's re-fold
   replaces the objects, which makes a stale entry unreachable rather than
   wrong, and a closed thread's entries collect with its items. The len/last
   check catches a turn that gained items without changing its head. */
const TURN_SOURCES_CACHE = new WeakMap<
  ThreadItem,
  { len: number; last: ThreadItem; sources: TurnSources }
>()

function cachedTurnSources(turn: ThreadItem[]): TurnSources {
  const first = turn[0]
  const last = turn[turn.length - 1]
  const hit = TURN_SOURCES_CACHE.get(first)
  if (hit && hit.len === turn.length && hit.last === last) return hit.sources
  const sources = turnSources(turn)
  TURN_SOURCES_CACHE.set(first, { len: turn.length, last, sources })
  return sources
}

/** Every finished turn, paired with the id of the row it ends on — the anchor
    both footers hang off. A turn still streaming is left out: a strip that
    grows under the reader is worse than one that arrives when the answer does.
    Shared by the sources strip and the token figure, which are two answers to
    "what came of this turn" and must sit in the same place.
    The turn is always the WHOLE turn, even under `answersOnly`: what a turn
    cited and what it cost are read off the steps, which is exactly what that
    option takes off the screen. Only the anchor moves — to the last row of the
    turn still drawn, since a footer hung off a hidden item is dropped. */
function finishedTurns(
  items: ThreadItem[],
  turnActive: boolean,
  answersOnly = false
): { turn: ThreadItem[]; tailId: string }[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  /* The row a turn ends on. A subagent's item is not a row of its own — it is
     drawn under the step that launched it — so a turn that ends inside a
     subagent's rail ends, as far as the rows go, on that step. */
  const rootOf = (item: ThreadItem): ThreadItem => {
    let current = item
    for (let depth = 0; current.parentId && depth < 16; depth++) {
      const owner = byId.get(current.parentId)
      if (!owner) break
      current = owner
    }
    return current
  }
  const turns = splitTurns(items)
  const out: { turn: ThreadItem[]; tailId: string }[] = []
  const tailOf = (turn: ThreadItem[]): ThreadItem | undefined => {
    if (!answersOnly) return turn[turn.length - 1]
    for (let i = turn.length - 1; i >= 0; i--) if (isAnswerItem(turn[i])) return turn[i]
    return undefined
  }
  turns.forEach((turn, index) => {
    if (index === turns.length - 1 && turnActive) return
    const last = tailOf(turn)
    if (!last || turn[0].kind !== "user") return
    out.push({ turn, tailId: rootOf(last).id })
  })
  return out
}

function withTurnSources(
  items: ThreadItem[],
  turnActive: boolean,
  answersOnly: boolean
): Map<string, TurnSources> {
  const after = new Map<string, TurnSources>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, answersOnly)) {
    const sources = cachedTurnSources(turn)
    if (sources.sources.length > 0) after.set(tailId, sources)
  }
  return after
}

/** What each finished turn cost, keyed by the row it ends on. The numbers are
    the store's (`turnUsage`, filed by `turn_ended`); the turn is matched to
    them by the `turnId` on the message that opened it, which is the only thing
    tying a transcript position to a reading that arrives long after it. A turn
    whose agent reported no usage — or one older than this feature, replayed
    from a journal that has the reading but whose user row was never tagged —
    simply has no entry, and nothing is drawn. */
function withTurnUsage(
  items: ThreadItem[],
  turnActive: boolean,
  turnUsage: Record<string, acp.Usage>,
  answersOnly: boolean
): Map<string, acp.Usage> {
  const after = new Map<string, acp.Usage>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, answersOnly)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const usage = turnId ? turnUsage[turnId] : undefined
    if (usage) after.set(tailId, usage)
  }
  return after
}

/** Every row's turn, keyed by the row's own id. A step's popover reads the
    billed split of the turn it sits in here (`StepTokens`), since a runtime
    reports only a total per model request and the prompt/output/cache split
    once, at turn end. The walk is the same one `withTurnUsage` does for the
    footer — the nearest user row back, which is the only thing tying a
    transcript position to a reading that arrives after it — but kept per row. */
function withStepTurnUsage(
  items: ThreadItem[],
  turnUsage: Record<string, acp.Usage>
): Record<string, acp.Usage> {
  const after: Record<string, acp.Usage> = {}
  let turnId: string | undefined
  for (const item of items) {
    if (item.kind === "user") turnId = item.turnId
    const usage = turnId ? turnUsage[turnId] : undefined
    if (usage) after[item.id] = usage
  }
  return after
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

/** A transcript, addressed by the pair that names it. The panel above hands
    the key down (see workspace/chat-panel): every store read, every action and
    every device-local draft below is keyed by it, because a bare session id is
    unique only on the server that minted it. */
export function ThreadView({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  /* Narrow subscriptions, not the wide hook: the dock keeps every opened
     transcript mounted, and on `useStore()` a streamed token in ANY thread
     re-rendered every one of them and re-ran the derivations below. These two
     re-render exactly when this thread's own objects are replaced. */
  const dispatch = useDispatch()
  const thread = useThread(sessionId)
  /* An interrupt is resumable only while it is the last thing that happened:
     the turn is over, the agent is still there, and nothing has been said
     since. Anything older is history, and history does not get a button. */
  const options = useViewOptions()
  const follow = useFollowStream(options.autoScroll)
  /* Paging back costs a round trip and then a re-fold of the whole widened
     window. Only the round trip can be paid before it is asked for, so it is:
     when the top of the transcript comes within a screenful of the viewport,
     the next page is fetched and held, and the button — which stays a button,
     because a re-fold that moves the scroll position under a reader is not
     something to do on their behalf — pays only the fold. */
  const earlierRef = React.useRef<HTMLDivElement>(null)
  const hasEarlier = thread.earlier > 0
  React.useEffect(() => {
    const node = earlierRef.current
    const root = follow.viewport
    if (!hasEarlier || !node || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) actions.prefetchEarlier(sessionId)
      },
      // A screenful of warning. The observer fires once on connect too, which
      // is right: a thread short enough to show its own top has already
      // arrived at the boundary.
      { root, rootMargin: "800px 0px 0px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [actions, follow.viewport, hasEarlier, thread.earlier, sessionId])
  /* Memoised separately: `.filter` would hand `rows` a fresh array every render
     even when nothing changed, and `rows`' memo depends on it. Two stable layers
     (items → visible → rows) is what lets a streaming update — which mutates one
     item in place via the reducer's new-array-of-old-refs — leave every unchanged
     row's identity alone so the memo below actually skips them. */
  /* Nothing is filtered out: a plan is drawn here, in the flow, at the point in
     the conversation where the agent wrote it — like every other thing it did.
     It used to be lifted onto the composer shelf, which cost more than it
     bought: the shelf could only draw the checklist variant, so `plan_update`'s
     markdown and file plans were rendered in neither place, and a plan lifted
     out of the flow loses the one thing the flow says about it — when, and
     after what, the agent decided on it. It still updates in place, since the
     reducer replaces the item it already holds.

     One exception, and it is the reader's own: `answersOnly` keeps the
     conversation and drops the work (see lib/transcript-rows.isAnswerItem).
     Filtered here, at the top of the derivation, so nesting, grouping, the
     rail and every row memo below are unchanged — and identity-stable, since
     `filter` preserves the item objects the reducer hands back. The full list
     is still what the turn footers are computed from: what a turn cited and
     what it cost are read off the steps this option hides. */
  const visible = React.useMemo(
    () => (options.answersOnly ? thread.items.filter(isAnswerItem) : thread.items),
    [thread.items, options.answersOnly]
  )
  /* Nesting folds a subagent's work under its step; grouping folds a *run*
     of steps into one row. Both are computed here, not in the reducer: they
     are ways of looking at the transcript, not changes to it, and toggling
     the option must not touch a single item. See lib/transcript-rows. */
  const rows = React.useMemo(
    () => buildRows(visible, options.groupTools, thread.turnActive),
    [options.groupTools, visible, thread.turnActive]
  )
  /* Where a Sources strip goes: after the item that ends each finished turn.
     Keyed by that item's id so the lookup below is one map hit per row, and
     a grouped run — whose last step may be the item — is checked by its tail. */
  const sourcesAfter = React.useMemo(
    () => withTurnSources(thread.items, thread.turnActive, options.answersOnly),
    [thread.items, thread.turnActive, options.answersOnly]
  )
  const sourcesFor = (row: Row): TurnSources | undefined => sourcesAfter.get(rowTailId(row))
  /* What the turn cost, in the same slot the sources sit in — the two are the
     turn's footer, and a reader looking for either looks in one place. */
  const usageAfter = React.useMemo(
    () => withTurnUsage(thread.items, thread.turnActive, thread.turnUsage, options.answersOnly),
    [thread.items, thread.turnActive, thread.turnUsage, options.answersOnly]
  )
  const usageFor = (row: Row): acp.Usage | undefined => usageAfter.get(rowTailId(row))
  const stepTurnAfter = React.useMemo(
    () => withStepTurnUsage(thread.items, thread.turnUsage),
    [thread.items, thread.turnUsage]
  )
  /* Hoisted out of the map below: `findIndex` inside `rows.map` was O(n²) per
     render, re-scanned on every streamed token. */
  const firstUserIndex = React.useMemo(() => rows.findIndex((r) => r.kind === "user"), [rows])
  /* The thread's true tail, not the filtered one: it is what "is this row the
     one still being written" is asked against, and under `answersOnly` the
     newest item is usually a step that is not on screen — measured against the
     filtered list, the previous answer would wear the streaming caret for the
     whole of a tool run. No row matches a hidden tail, which is the right
     answer: the working line above the composer is what says a turn is live. */
  const last = thread.items[thread.items.length - 1]
  const resumable =
    last?.kind === "notice" && !thread.turnActive && thread.phase.kind !== "failed"
      ? last.id
      : null
  /* actions.send records its own failure in the transcript (with the text, so
     the row it leaves behind can offer Retry) — a toast on top would say the
     same thing twice. */
  const resume = () => void actions.send(sessionId, "Continue.").catch(() => {})
  const retry = (text: string) => void actions.send(sessionId, text).catch(() => {})
  /* The one exception to "attachments do not survive Retry", and it exists for
     the one failure `resolveDelivery` cannot prevent: a model whose catalog
     claims `image` and whose provider refuses it anyway. Same bytes, same text,
     pinned to the materialise-and-link branch. */
  const retryAsPaths = (item: Extract<ThreadItem, { kind: "error" }>) =>
    void actions
      .send(sessionId, item.retryText ?? "", {
        attachments: item.retryAttachments,
        forceLink: true,
      })
      .catch(() => {})

  const meta = useSessionMeta(sessionId)
  /* What an attachment on this thread would actually do — read once here
     because two surfaces need the same answer: the composer's chips forecast
     it, and an error row uses it to decide whether "Retry as file paths" would
     change anything. */
  const delivery = useAttachmentDelivery(meta, thread)
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
           one, so unkeyed items are invisible to the scroller.
           The primitive's own follow is kept (it is what hides the
           scroll-to-bottom button while following) but it is not trusted on its
           own — `useFollowStream` owns the pin. See hooks/use-follow-stream. */}
      <MessageScrollerProvider autoScroll={options.autoScroll}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={follow.viewportRef}>
            <ViewOptionsContext.Provider value={options}>
            <StepTokensProvider value={{ step: thread.stepUsage, turn: stepTurnAfter }}>
            <MessageScrollerContent
              ref={follow.contentRef}
              data-answers={options.answersOnly ? "only" : undefined}
              data-density={options.compactDensity ? "compact" : undefined}
              data-wrap={options.codeWrap ? "on" : undefined}
              data-motion={options.calmMotion ? "calm" : undefined}
              className={cn(
                "thread-transcript mx-auto w-full gap-0.5 px-4 py-4",
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
              {/* The transcript begins in the middle: this thread was long
                  enough that the server sent only its tail. The rest is still
                  there and comes back a page at a time. */}
              {thread.earlier > 0 && (
                <MessageScrollerItem messageId="earlier">
                  <div
                    ref={earlierRef}
                    className="mb-2 flex items-center justify-center gap-2 text-xs text-muted-foreground"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={thread.loadingEarlier}
                      onClick={() => void actions.loadEarlier(sessionId)}
                    >
                      <ChevronUp className={cn("size-4", thread.loadingEarlier && "animate-pulse")} />
                      {thread.loadingEarlier ? "Loading…" : "Load earlier steps"}
                    </Button>
                    <span>{thread.earlier} earlier step{thread.earlier === 1 ? "" : "s"}</span>
                  </div>
                </MessageScrollerItem>
              )}
              {rows.map((row, i) => {
                /* A hairline above each of your messages (except the first)
                    separates one turn from the next when Turn dividers is on. */
                const isUser = row.kind === "user"
                const divider = options.stepDividers && isUser && i !== firstUserIndex
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
                  /* What kind of row this is, for the one thing CSS has to know
                     about it: under `answersOnly` the steps between two stretches
                     of prose are gone, and the padding they were separated by is
                     a gap in the middle of what is now one answer. Collapsed in
                     index.css against the *adjacency*, which is a fact only the
                     rendered list has — see the [data-answers="only"] block. */
                  data-row-kind={row.kind}
                  data-settled={!thread.turnActive ? "true" : undefined}
                >
                  {divider && (
                    <div aria-hidden className="my-1.5 h-px bg-border/50 first:hidden" />
                  )}
                  {/* The entrance wrapper (index.css): one per row, so the
                      divider and the Sources strip sit beside it — each mounts
                      at its own moment and rises in on its own. */}
                  <div className="harness-item-in">
                    <RowView
                      row={row}
                      onContinue={resumable === row.id ? resume : undefined}
                      onRetry={
                        row.kind === "error" && row.retryText
                          ? () => retry(row.retryText!)
                          : undefined
                      }
                      /* Offered only when something on that turn would actually
                         have been inlined — a turn whose files all went as paths
                         already failed for some other reason, and a button that
                         changes nothing is worse than no button. Read through
                         the same `resolveDelivery` the chip's note and the
                         bridge's branch use. */
                      onRetryAsPaths={
                        row.kind === "error" && wentInline(row, delivery)
                          ? () => retryAsPaths(row)
                          : undefined
                      }
                      onDismiss={
                        row.kind === "error"
                          ? () => dispatch({ type: "dismiss-error", id: sessionId, itemId: row.id })
                          : undefined
                      }
                      showTimestamps={options.showTimestamps}
                      streaming={thread.turnActive && last !== undefined && rowTailId(row) === last.id}
                    />
                  </div>
                  {options.showSources && sourcesFor(row) && (
                    <div className="harness-item-in">
                      <SourcesStrip turn={sourcesFor(row)!} />
                    </div>
                  )}
                  {options.showTokens && usageFor(row) && (
                    <div className="harness-item-in -ml-1">
                      <TokenSummary usage={usageFor(row)!} label="This turn" />
                    </div>
                  )}
                </MessageScrollerItem>
                )
              })}
              {/* The wait sits at the FOOT of the transcript, not its head: a
                  replay arrives oldest-first and the scroller is pinned to the
                  bottom, so a line at the top is the one place the reader is
                  not looking — it announced the wait above content that was
                  still landing under it, and then vanished from off-screen.
                  Here it is where the next thing to happen will happen, in the
                  same slot the working line takes once the thread is live. */}
              {startingLine(thread.phase) && (
                <MessageScrollerItem messageId="starting">
                  <StartingLine phase={thread.phase} />
                </MessageScrollerItem>
              )}
              {/* Suppressed while the thread is opening: the StartingLine just
                  above already owns the wait, and two animated lines over one
                  message read as "we don't know what is happening" rather than
                  as progress. Reaching `live` hands the wait back here. */}
              {thread.turnActive && !startingLine(thread.phase) && (
                <MessageScrollerItem messageId="working">
                  <div className="harness-item-in">
                    <div className="py-0.5">
                      <ActivityIndicator thread={thread} />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
              {/* The two things that stop a turn dead, at the tail of the flow
                  where the turn is: an approval and a question are the same
                  event to a reader, and they are drawn on the same card. Both
                  come after the working line — whatever the agent got as far as
                  saying is above the thing it stopped on. */}
              {thread.permission && (
                <MessageScrollerItem messageId="permission">
                  <div className="harness-item-in">
                    <div className="py-1">
                      <InlineApproval permission={thread.permission} />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
              {thread.elicitation && (
                <MessageScrollerItem messageId="elicitation">
                  <div className="harness-item-in">
                    <div className="py-1">
                      <InlineElicitation elicitation={thread.elicitation} />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
            </StepTokensProvider>
            </ViewOptionsContext.Provider>
          </MessageScrollerViewport>
          {/* The primitive's own scroll-to-end runs on click; re-pinning here as
              well is what makes the button mean "and keep up from now on"
              instead of "put me at the bottom once". */}
          <MessageScrollerButton onClick={follow.follow} />
          {/* Inside the Root, not the Viewport: it is an overlay on the
              transcript, and it needs the Provider above it for
              `scrollToMessage`/`currentAnchorId`. It draws nothing under two
              turns, so a short thread pays for it only in a hook call. */}
          {options.turnRail && <ThreadRail items={visible} wide={options.wideTranscript} />}
        </MessageScroller>
      </MessageScrollerProvider>
      {/* min-w-0, and it is load-bearing: a grid item's automatic minimum is
          `min-content`, so the composer's row was as wide as the widest
          unbreakable thing on the shelf — a queued message holding a URL or a
          long path made the whole column wider than the panel and pushed the
          composer off the side of the screen. (The strip's own
          `max-w-[calc(min(100%,…))]` cannot prevent that: a percentage max-width
          is ignored while intrinsic contributions are being measured.) With the
          minimum at 0 the track is the panel's width, the strip fills it, and
          the rows inside truncate and wrap as they were written to. The same
          reasoning as every `min-h-0` on the rows above — the axis is the only
          difference. */}
      <div className="relative min-w-0">
        {empty && <ThreadWelcome draft={meta?.draft} />}
        <Composer
          sessionId={sessionId}
          actions={actions}
          thread={thread}
          meta={meta}
          delivery={delivery}
        />
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

/** The one line a starting thread is allowed to say, staged through the phases
    the client can actually tell apart: while the draft flag holds, the POST that
    spawns the agent and runs the handshake is in flight; once the server's row
    has replaced it, the socket is opening; and once `attached` has landed, the
    journal is replaying toward `caught_up`.

    The last of those is the one that used to be missing, and its absence made
    the line say something it had no evidence for. Before `attached` this client
    knows nothing about the thread's *size* — the wait is the network, the
    socket, or a server busy with someone else's turn — yet the slow line blamed
    "a long conversation" either way, sending the reader to look at a length that
    was frequently not the problem. So the two waits are told apart, and only the
    second one is allowed to talk about the conversation: it is the one with a
    number behind it.

    That number is why there is a bar rather than a longer apology. `attached`
    states where the replay ends, so the wait is a quantity from the first frame
    and the reader can see it moving. The rule is the service worker's, which had
    the same problem in a harder form (see `sw.ts`): no bar until the total is
    known, because a spinner is how "not known yet" is said and a bar drawn
    against nothing is a lie that jumps. A *short* replay draws none either — it
    is over in a blink, and a bar that appears and vanishes is noise about work
    nobody waited for. */
const SLOW_MS = 6_000

/** Replays smaller than this fold imperceptibly; below it the progress is true
    but not worth drawing. */
const LONG_REPLAY_EVENTS = 400

function StartingLine({ phase }: { phase: ConnPhase }) {
  const [slow, setSlow] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  const line = startingLine(phase)
  if (!line) return null
  /* A bar only when there is a number behind the wait AND the wait is long
     enough to be felt. Below the threshold the fold is imperceptible and a bar
     that appears and vanishes is noise about work nobody waited for. */
  const bar = line.bar && line.bar.total >= LONG_REPLAY_EVENTS ? line.bar : null
  const slowText = slow ? slowLine(phase) : null
  return (
    <div className="py-2">
      <div className="harness-shimmer text-xs text-primary">{line.text}</div>
      {bar ? (
        <div className="flex max-w-xs items-center gap-2 pt-1.5">
          <Progress
            value={bar.done}
            max={bar.total}
            className="flex-1 [&_[data-slot=progress-track]]:h-1"
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.min(99, Math.floor((bar.done / bar.total) * 100))}%
          </span>
        </div>
      ) : (
        slowText && <div className="pt-1 text-xs text-muted-foreground">{slowText}</div>
      )}
    </div>
  )
}


/* ── Prompt history ──
   Up recalls what you have already sent in this thread, the way a shell recalls
   a command. The history IS the transcript — every user turn, oldest last — so
   there is nothing to persist and nothing that can disagree with what is on
   screen above the box. Walking back stashes whatever was half-typed; Escape,
   and walking forward off the end, put it back. */
function usePromptHistory(items: ThreadItem[], setText: (text: string) => void) {
  /* The list only changes when a user message is added (or its item object
     replaced) — never per streamed token — but `items` is a new array on every
     token, so a memo keyed on it re-scanned the transcript constantly. Keyed
     instead on the count and the identity of the last user item: the reducer
     replaces an item object whenever its content changes, so the pair is an
     exact fingerprint of the user turns. */
  const cache = React.useRef<{ count: number; last: ThreadItem | null; history: string[] }>({
    count: -1,
    last: null,
    history: [],
  })
  let userCount = 0
  let lastUser: ThreadItem | null = null
  for (const item of items) {
    if (item.kind === "user" && item.text) {
      userCount++
      lastUser = item
    }
  }
  if (userCount !== cache.current.count || lastUser !== cache.current.last) {
    cache.current = {
      count: userCount,
      last: lastUser,
      history: items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])),
    }
  }
  const history = cache.current.history
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


function Composer({
  sessionId,
  actions,
  thread,
  meta,
  /* Resolved by ThreadView and handed down: the transcript's error rows read
     the same answer (see `wentInline`), and two `useAttachmentDelivery` calls
     in one tree would be two subscriptions to the same absolute state. */
  delivery,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  meta?: SessionMeta
  delivery: AttachmentDelivery
}) {
  const navigate = useNavigate()
  const location = useLocation()
  /* The draft lives on this device, per session (lib/drafts). ThreadView is
     keyed by the thread's key today so the initializer would be enough — the effect
     keeps it correct if that key ever goes away. */
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
  const [reviving, setReviving] = React.useState(false)
  const isMobile = useIsMobile()
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

  /* The draft is cleared optimistically: a failure leaves a transcript row that
     carries the exact text and a Retry button, which is a better home for it
     than a textarea the user has since typed into.

     `/schedule` is intercepted here rather than sent: it is the harness's own
     command (see slash-commands.tsx), so its text opens the schedule form
     pre-filled instead of reaching the agent — which is also why the draft is
     NOT cleared on that path. The message has not been sent anywhere yet, and
     the form is a place you can back out of. */
  const send = (opts: { steer?: boolean } = {}) => {
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
      void navigate(schedulePath(sessionId), {
        state: {
          /* Expanded here too: the form is going to store this text on the
             server, where the sidecar that a token points into does not exist.
             The draft and its pastes are deliberately NOT cleared — nothing has
             been sent, and the form is a place you can back out of. */
          defaultText: expandPastes(command.args, pastes),
          returnTo: location.pathname + location.search,
        },
      })
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
    void actions.send(sessionId, outgoing, { ...opts, attachments, onUnsent }).catch(() => {})
  }

  /* Up/Down walk what has already been sent here. It goes after the slash menu
     in the key handler below: while that menu is open the arrows are its. */
  const history = usePromptHistory(thread.items, setText)

  /* Running an agent command is just sending `/name args` as the prompt — the
     agent resolves it — so the menu only completes the name. Drafts advertise
     no commands (no process yet); they are also offered no harness commands,
     because `/schedule` needs a thread the server knows about to schedule
     against, which a draft is not until its first message. */
  const slash = useSlashCommands(
    text,
    thread.availableCommands,
    setText,
    draft ? [] : HARNESS_COMMANDS
  )

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
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? start
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
            <DraftScopeRow meta={meta} actions={actions} />
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
            paste parked behind a token. */}
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

          It is also the drop target, and deliberately the whole card rather
          than the textarea: a file aimed at "the composer" lands on the button
          row or the padding as often as on the box. `dragCounter` is what makes
          the overlay stable — `dragleave` fires as the pointer crosses into a
          child, so a boolean would flicker the whole way across. */}
      <div
        className="relative z-10 mx-auto w-full max-w-[var(--harness-composer-width)] rounded-2xl bg-composer p-2 shadow-glass-lg"
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
               plain one by the person pressing it. */
            if (steerChords.some((chord) => matchesChord(e, chord))) {
              e.preventDefault()
              send({ steer: true })
              return
            }
            /* Bare Enter sends on desktop and inserts a newline on touch, where
               Return is the only newline key there is and every soft keyboard
               shows it as one. Shift+Enter is the desktop escape hatch. IME
               composition is left alone — Enter is how you accept a
               candidate. */
            if (isMobile || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          aria-label="Message the agent"
          placeholder={
            lock.note ??
            (thread.turnActive
              ? "Queue a message for when the agent finishes…"
              : "Message the agent…")
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
          <ContextIndicator thread={thread} meta={meta} actions={actions} />
          {/* The touch path — ⌘V and drag-and-drop cover the pointer, and
              neither exists on a phone. No chord: `lib/shortcuts.ts` holds the
              rule that a bound key is a listed key, and this does not need to
              spend one. */}
          <input
            ref={filePicker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) files.add(e.target.files)
              // Cleared, or picking the same file twice fires no change event.
              e.target.value = ""
            }}
          />
          <Button
            variant="ghost"
            /* The size is the *device's* question, not the panel's: a narrow
               chat panel on a desktop is still driven by a mouse, and this is
               the one control on the row that is the only way in on touch. */
            size={isMobile ? "icon" : "icon-sm"}
            className="shrink-0 rounded-lg"
            onClick={() => filePicker.current?.click()}
            disabled={disabled}
            title="Attach a file"
          >
            <Paperclip />
          </Button>
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
            onClick={() => send()}
            disabled={
              disabled ||
              !lock.submittable ||
              files.uploading ||
              (!text.trim() && files.ready.length === 0)
            }
            title={
              thread.turnActive
                ? `Queue (${formatChord(steerChords[0] ?? "")} steers the running turn instead)`
                : "Send"
            }
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ── The transcript surface ── the scroller and its autoscroll pin, the
   windowing behind `load_earlier`, the turn rail, the row footers, the
   approval / question / held-turn cards, the docked composer and the rewind
   dialog. The parts that are not the surface live beside it and are imported
   one way, from here: `turn-footers.ts` (the per-turn derivations),
   `thread-keys.ts` (Escape and the digits), `starting-line.tsx` (the
   connection wait) and `welcome.tsx` (the empty state the landing console
   shares). `thread-view.tsx` above is the barrel that keeps `ThreadView` and
   `ThreadWelcome` at the path every caller already spells. */
import type { RequestFrom, TurnGeneration } from "@daedalus/protocol"
import { ScrollToEnd } from "@/components/thread-view/scroll-to-end"
import * as React from "react"
import type * as acp from "@daedalus/acp"
import { ArrowUpRightIcon, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/busy-button"
import { ComposerQueue } from "@/components/composer-queue"
import { useAttachmentDelivery, wentInline } from "@/components/composer-attachments"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import type { Actions } from "@/lib/actions"
import { KEYBOARD_CENTER_FLOW, KEYBOARD_LIFT, KEYBOARD_LIFT_FOCUSED } from "@/lib/keyboard-inset"
import { holdOf } from "@/lib/thread/hold"
import { isOpening } from "@/lib/thread/phase"
import { currentThreadId, navigateTo, threadPath } from "@/lib/router"
import { openInNewTab } from "@/lib/workspace/open-threads"
import { useDispatch, useSessionMeta, useThread, threadIsEmpty, workLive, type ThreadItem, type ToolItem } from "@/lib/store"
import { FilePreviewContext, type FilePreviewValue } from "@/lib/file-preview"
import { DockContext, useIsFrontPanel } from "@/components/workspace/dock-context"
import { useProfiles, useProjects } from "@/lib/queries/catalog"
import { useProjectScripts } from "@/lib/queries"
import { DEFAULT_SUGGEST_KINDS, type SuggestGroup } from "@/lib/suggestions"
import { HOME_PROJECT_ID } from "@/lib/workspace/panels"
import { Link, useLocation } from "react-router"
import { useLayoutOptions, LayoutOptionsContext } from "@/lib/layout-options"
import { useFollowStream } from "@/hooks/use-follow-stream"
import { cn, stagger } from "@/lib/utils"
import { burstMs, gapMinMs } from "@/lib/tool-batches"
import { ThreadIdContext } from "@/lib/thread-id-context"
import { OpenuiActionsContext } from "@/lib/openui/actions"
import { StepTokensProvider, createStepTokensStore } from "@/components/token-usage"
import { TurnFooter } from "@/components/thread-view/turn-footer"
import { InlineElicitation } from "@/components/elicitation-form"
import { InlineApproval } from "@/components/tool-approval"
import { InlineHeldTurn } from "@/components/held-turn"
import { ThreadStatus } from "@/components/thread-view/thread-status"
import { PendingSettings } from "@/components/thread-view/pending-settings"
import { useThreadStatus } from "@/lib/thread/status"
import { RowView, StepGap } from "@/components/thread-items/rows"
import type { TurnSources } from "@/lib/sources"
import { buildRows, proseGapAfter, rowTailId, separatorAfterRun, shareRows, streamingRowIds, type Row } from "@/lib/transcript-rows"
import { Composer, type ComposerHandle } from "@/components/composer/composer"
import { ThreadRail } from "@/components/thread-rail"
import { RewindDialog, type RewindScope } from "@/components/rewind-dialog"
import { useAgents } from "@/lib/queries/catalog"
import {
  useStepCalls,
  useStepTurnUsage,
  useTurnCalls,
  withTurnDuration,
  withTurnToolDuration,
  withTurnGeneration,
  withTurnSources,
  withTurnSuggestions,
  withTurnChanges,
  withTurnUsage,
} from "@/components/thread-view/turn-footers"
import { useShortcut } from "@/hooks/use-hotkey"
import {
  InspectorContext,
  ThreadJumpContext,
  inspectorPrefs,
  setInspectorPref,
  type InspectorTab,
} from "@/lib/inspector"
import { useServer } from "@/lib/server-context"
import { useVoiceCallLifetime } from "@/lib/voice-call"

import { sessionChanges } from "@/lib/workspace/git-api"
import { useEarlierAnchor } from "@/components/thread-view/earlier-anchor"
import { useThreadKeys } from "@/components/thread-view/thread-keys"
import { useWaitShown } from "@/components/thread-view/starting-line"
import { ThreadSkeleton } from "@/components/thread-view/skeleton"
import { ThreadWelcome } from "@/components/thread-view/welcome"
import { LandingConsoleContext } from "@/components/landing/landing-console"
import { ThreadInspector } from "@/components/thread-view/thread-inspector"
import { QuoteSelection } from "@/components/thread-view/quote-selection"
import { AsideWindow, type AsideAt } from "@/components/thread-view/aside-window"
import { useAsideHighlights } from "@/components/thread-view/aside-highlights"
import {
  Dormant,
  DormancyProvider,
  JumpPrepProvider,
  useDormancyRoot,
  useTranscriptJump,
} from "@/components/thread-view/dormant"
import { RowMemoryContext, clearSettled, type RowMemory } from "@/lib/row-open"
import type { ThreadCall } from "@/lib/trace"

/** How wide the *panel* must be for the inspector to dock beside the
    transcript (`--container-panel-lg`, 64rem); below it the column is a sheet. */
const INSPECTOR_WIDE = 1024
/** What the transcript keeps when the inspector is dragged wider. */
const INSPECTOR_TRANSCRIPT_MIN = 480
/* Dormancy (`dormant.tsx`) starts past this many rows — a thread shorter than
   it costs little enough mounted whole, and keeps find-in-page over all of it
   — and never reaches the newest `DORMANT_KEEP_TURNS` turns, which hold the
   live tail and everything a reply is read against. */
const DORMANT_MIN_ROWS = 120
const DORMANT_KEEP_TURNS = 2
/* One empty list, so a thread with no scripts does not hand `definedCommands`
   — and the suggestion cache keyed on it — a new set every render. */
const NO_SCRIPTS: readonly never[] = []
/* The same, for the rows a closed turn is still writing: none. Kept at one
   identity so the memo below does not hand every row a new set per render. */
const EMPTY_ROWS: ReadonlySet<string> = new Set()

/** Whether an item is drawn inside this row — the row itself, or a group any
    level down (a subagent, tool group, workflow, or batch). */
function rowContains(row: Row, id: string): boolean {
  if (row.id === id) return true
  if (row.kind === "work-fold") return row.rows.some((child) => rowContains(child, id))
  if (row.kind === "subagent-group")
    return row.launch?.id === id || row.children.some((child) => rowContains(child, id))
  if (row.kind === "tool-group")
    return row.items.some((item) => item.id === id) || row.children.some((child) => rowContains(child, id))
  if (row.kind === "workflow-group" || row.kind === "subagent-batch")
    return row.steps.some((step) => rowContains(step, id))
  if (row.kind === "run") return row.items.some((item) => item.id === id)
  return false
}

type RowHandlers = {
  resume: () => void
  rewind: () => void
  fork: () => void
  retry: () => void
  retryAsPaths: () => void
  dismiss: () => void
}

/** A row's entrance, decided once, when it mounts. Toggling the class on a
    mounted row would start the animation there and then, so a thread that
    finished replaying would rise in whole a second time. */
function Entrance({ animate, children }: { animate: boolean; children: React.ReactNode }) {
  const [on] = React.useState(animate)
  return (
    <div className={on ? "harness-item-in" : undefined} style={on ? stagger(0) : undefined}>
      {children}
    </div>
  )
}

/** A transcript, addressed by the pair that names it. The panel above hands
    the key down (see workspace/chat-panel): every store read, every action and
    every device-local draft below is keyed by it, because a bare session id is
    unique only on the server that minted it. */
/** Over a card a child thread is blocked on (an ask, a workflow step): whose
    question it is, and the way into that thread. The answer goes back to the
    child — the server routes it by the request's id. */
function AskedBy({ from }: { from: RequestFrom }) {
  return (
    <p className="mb-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="truncate">
        Asked by <span className="font-medium text-foreground">{from.title}</span>
      </span>
      <Link
        to={threadPath(from.sessionId)}
        className="inline-flex shrink-0 items-center gap-1 hover:text-foreground"
      >
        Open thread <ArrowUpRightIcon className="size-3" />
      </Link>
    </p>
  )
}

export function ThreadView({
  sessionId,
  actions,
  docked = false,
  pinComposer = false,
}: {
  sessionId: string
  actions: Actions
  /** The transcript panel of a thread dock (`workspace/thread-dock.tsx`): the
      readings are panels beside it there, so this view draws no inspector of
      its own and answers "Open in inspector" with the dock's door. */
  docked?: boolean
  /** Keep the composer at the bottom even while the thread is empty, with no
      welcome over it — the aside window (`aside-window.tsx`). */
  pinComposer?: boolean
}) {
  /* Narrow subscriptions, not the wide hook: the dock keeps every opened
     transcript mounted, and on `useStore()` a streamed token in ANY thread
     re-rendered every one of them and re-ran the derivations below. These two
     re-render exactly when this thread's own objects are replaced. */
  const dispatch = useDispatch()
  const thread = useThread(sessionId)
  /* What the composer and the inspector draw. Both take the whole thread (the
     indicators read `items`), so on the urgent value they re-rendered with the
     transcript on every streamed token — the composer's Tiptap editor
     included, which is what made typing during a stream lag. Deferred, React
     renders them at low priority and drops the frames a newer token has
     already replaced. */
  const lazyThread = React.useDeferredValue(thread)
  const hold = holdOf(thread)
  /* Rows animate in only once the view is up and the thread is live: a replay,
     or a thread opened with its transcript already in the store, mounts every
     row on one frame, and 480ms of every row rising together is lag, not news. */
  const mounted = React.useRef(false)
  React.useEffect(() => {
    mounted.current = true
  }, [])
  const animateEntrance = mounted.current && !isOpening(thread.phase)
  /* Whether the connection's own wait is on screen — read by the two rows at
     the foot of the transcript that trade places with it. */
  const waitShown = useWaitShown(thread.phase)
  /* The connection's own answer, if it has one: a reconnecting, parked, failed,
     trashed or archive-only thread. It is the card at the head of the tail, and
     it *suppresses* the wait below — `reconnecting` is the one phase both would
     speak to, and saying it twice on one screen is the bug this gate closes. */
  const status = useThreadStatus(sessionId, waitShown)
  /* An interrupt is resumable only while it is the last thing that happened:
     the turn is over, the agent is still there, and nothing has been said
     since. Anything older is history, and history does not get a button. */
  /* Deferred, and this is the *only* place it is: a view option is read through
     `LayoutOptionsContext` by every row, tool pane and diff below, and a context
     value change punches straight through every `React.memo` on the way down —
     the same thing the `stepTokens` note further down guards against. With no
     virtualization, one flipped switch is a synchronous re-render of every row
     in the thread, so the click that flipped it waited for the whole transcript
     before the switch itself moved.

     `useDeferredValue` splits that in two: the dialog reads the store directly
     (`layout-settings.tsx`), so its switch is still instant, and the
     transcript re-renders at low priority a frame behind. Nothing here is
     time-critical enough to notice the frame — `autoScroll` included.

     Not `startTransition` at the write: `useLayoutOptions` is a
     `useSyncExternalStore`, and an external store's update is always urgent.
     Deferring the value is the only side of this that works. */
  const options = React.useDeferredValue(useLayoutOptions())
  const follow = useFollowStream(options.autoScroll)
  const dormancy = useDormancyRoot(follow.viewport)
  const jumpPrep = React.useMemo(
    () => ({ release: follow.release, wake: dormancy?.wake }),
    [follow.release, dormancy]
  )
  /* The reader's open/closed answers for rows that went dormant — this view's,
     not the thread's (`lib/row-open`). */
  const [rowMemory] = React.useState<RowMemory>(() => new Map())
  /* Every option a row's `openSetting` is built from: when one moves, a
     mounted row resets itself, and a dormant one would come back holding an
     answer given under the old value — even once the option is flipped back. */
  const openSettings = `${options.showToolDetails}:${options.expandEdits}:${options.showThinking}`
  React.useEffect(() => clearSettled(rowMemory), [openSettings, rowMemory])
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
  /* The click that pages history back is the one thing on this surface that
     moves the scroll position under the reader: the re-fold replaces every row
     and the position has to be put back by hand. See the helper. */
  /* A thread short enough to be pinned at its tail would otherwise be carried
     to the end by the growth the page adds above it: release the pin first. */
  const loadEarlier = useEarlierAnchor(follow.viewport, thread.loadingEarlier, () => {
    follow.release()
    void actions.loadEarlier(sessionId)
  })
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

     `answersOnly` is not one of these filters: it folds the work rather than
     dropping it (`foldWork`, the last pass in `buildRows`), so every item is
     still here and a turn's footer still has the steps to read from. What is
     filtered is only what is never drawn at all. Identity-stable, since
     `filter` preserves the item objects the reducer hands back. */
  const visible = React.useMemo(
    () =>
      thread.items.filter(
        (item) =>
          !(item.kind === "error" && item.transient) &&
          (options.showShellCommands || item.kind !== "shell") &&
          (options.showConfigNotices || item.kind !== "notice" || item.config !== true)
      ),
    [thread.items, options.showShellCommands, options.showConfigNotices]
  )
  /* Nesting folds a subagent's work under its step; grouping folds a *run*
     of steps into one row; `answersOnly` folds the work between the answers
     into one expandable line. All are computed here, not in the reducer: they
     are ways of looking at the transcript, not changes to it, and toggling the
     option must not touch a single item. See lib/transcript-rows. */
  /* Shared against the last build (`shareRows`): every group `buildRows`
     forms is a new object per call, and without this each subagent, workflow,
     run and fold re-rendered on every streamed token. The ref is written in
     render, which is safe because what it holds is always equal to the build. */
  const prevRows = React.useRef<Row[]>([])
  /* A subagent row reads as working while a turn is open OR while an ask or
     workflow run it launched is still going after the turn ended. */
  const working = workLive(thread)
  const rows = React.useMemo(
    () =>
      (prevRows.current = shareRows(
        prevRows.current,
        buildRows(
          visible,
          options.groupTools,
          working,
          options.groupShellCommands,
          !options.expandEdits,
          options.answersOnly,
          options.parallelGroups ? burstMs(options.batchBurst) : undefined
        )
      )),
    [
      options.answersOnly,
      options.batchBurst,
      options.expandEdits,
      options.groupTools,
      options.groupShellCommands,
      options.parallelGroups,
      visible,
      working,
    ]
  )
  /* Where a Sources strip goes: after the item that ends each finished turn.
     Keyed by that item's id so the lookup below is one map hit per row, and
     a grouped run — whose last step may be the item — is checked by its tail. */
  const sourcesAfter = React.useMemo(
    () =>
      withTurnSources(thread.items, thread.turnActive, options.showConfigNotices),
    [thread.items, thread.turnActive, options.showConfigNotices]
  )
  const sourcesFor = (row: Row): TurnSources | undefined => sourcesAfter.get(rowTailId(row))
  /* What the turn cost, in the same slot the sources sit in — the two are the
     turn's footer, and a reader looking for either looks in one place. */
  const usageAfter = React.useMemo(
    () =>
      withTurnUsage(thread.items, thread.turnActive, thread.turnUsage, options.showConfigNotices),
    [thread.items, thread.turnActive, thread.turnUsage, options.showConfigNotices]
  )
  const usageFor = (row: Row): acp.Usage | undefined => usageAfter.get(rowTailId(row))
  const durationAfter = React.useMemo(
    () =>
      withTurnDuration(thread.items, thread.turnActive, thread.turnDuration, options.showConfigNotices),
    [thread.items, thread.turnActive, thread.turnDuration, options.showConfigNotices]
  )
  const durationFor = (row: Row): number | undefined => durationAfter.get(rowTailId(row))
  const toolDurationAfter = React.useMemo(
    () =>
      withTurnToolDuration(thread.items, thread.turnActive, thread.turnToolDuration, options.showConfigNotices),
    [thread.items, thread.turnActive, thread.turnToolDuration, options.showConfigNotices]
  )
  const toolDurationFor = (row: Row): number | undefined => toolDurationAfter.get(rowTailId(row))
  const generationAfter = React.useMemo(
    () =>
      withTurnGeneration(thread.items, thread.turnActive, thread.turnGeneration, options.showConfigNotices),
    [thread.items, thread.turnActive, thread.turnGeneration, options.showConfigNotices]
  )
  const generationFor = (row: Row): TurnGeneration | undefined => generationAfter.get(rowTailId(row))
  const callsAfter = useTurnCalls(thread.items, thread.turnActive, thread.calls, options.showConfigNotices)
  const callsFor = (row: Row): ThreadCall[] | undefined => callsAfter.get(rowTailId(row))
  /* What each finished turn wrote, gated on the transcript (`withTurnChanges`
     — git measures a window, not an author). The newest gated turn is the
     reading the composer's `ChangesIndicator` and the inspector's Changes tab
     both draw; it stays put when the next turn only reads, because the
     question is "what has this thread done to the worktree". */
  const changesAfter = React.useMemo(
    () =>
      withTurnChanges(
        lazyThread.items,
        lazyThread.turnActive,
        lazyThread.turnChanges,
        options.showConfigNotices
      ),
    // Read only by the composer and the inspector, so it follows their value.
    [lazyThread.items, lazyThread.turnActive, lazyThread.turnChanges, options.showConfigNotices]
  )
  const latestChanges = React.useMemo(() => [...changesAfter.values()].at(-1), [changesAfter])
  /* The per-turn rows are the server's and live-only on the socket, so a
     transcript opened cold seeds them once here. Failure is silence: the
     reading is ambient, and a thread with no project has nothing to read. */
  const server = useServer()
  React.useEffect(() => {
    const controller = new AbortController()
    sessionChanges(server, sessionId, controller.signal)
      .then(({ turns }) => dispatch({ type: "turn-changes-all", id: sessionId, turns }))
      .catch(() => {})
    return () => controller.abort()
  }, [server, sessionId, dispatch])
  /* Held at one identity until a figure actually moves — see `useStepTurnUsage`.
     The raw walk returns a fresh object per token, and this is half of a
     *context* value, which no `React.memo` below it can absorb. */
  const stepTurnAfter = useStepTurnUsage(thread.items, thread.turnUsage)
  /* The other half is `thread.stepUsage`, which the reducer only replaces when
     a `usage_update` really marks a new step (`markStepUsage`) — so both inputs
     are stable between chunks and the transcript's memo boundaries hold. An
     object literal here is what made all five of them ornamental. */
  /* And even a stable value was one transcript-wide re-render per model step,
     because a context value change reaches every reader through every memo:
     the provider holds a store for the view's life instead, published after
     each commit, and a row re-renders only when its own entry moves. */
  /* The model call records drawn on each row — the step's own split, cache and
     timing for a runtime whose `usage_update` carries one undivided number. */
  const stepCalls = useStepCalls(thread.items, thread.calls)
  const [stepTokens] = React.useState(createStepTokensStore)
  stepTokens.prime({ step: thread.stepUsage, turn: stepTurnAfter, calls: stepCalls })
  React.useLayoutEffect(() => stepTokens.publish(), [stepTokens, thread.stepUsage, stepTurnAfter, stepCalls])
  /* Hoisted out of the map below: `findIndex` inside `rows.map` was O(n²) per
     render, re-scanned on every streamed token. */
  const firstUserIndex = React.useMemo(() => rows.findIndex((r) => r.kind === "user"), [rows])
  /* Rows before this index may sleep: the user row that opens the newest
     `DORMANT_KEEP_TURNS` turns, or 0 — none — in a thread too short to bother. */
  const settledBefore = React.useMemo(() => {
    if (rows.length <= DORMANT_MIN_ROWS) return 0
    let turns = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "user" && ++turns === DORMANT_KEEP_TURNS) return i
    }
    return 0
  }, [rows])
  /* Which rows are news: those after the last row of the previous commit. A
     row that mounts anywhere else is not arriving — a `load_earlier` re-fold
     or a replaced transcript mints new keys for rows the reader has already
     seen (the old last row is gone, so nothing counts), and a page prepended
     above lands before it — and rising in would be a replay of history. */
  const prevLast = React.useRef<string | undefined>(undefined)
  const freshFrom = React.useMemo(() => {
    if (prevLast.current === undefined) return 0
    const at = rows.findIndex((row) => row.id === prevLast.current)
    return at === -1 ? rows.length : at + 1
    // Read against the last *commit*, which the effect below records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  React.useEffect(() => {
    prevLast.current = rows[rows.length - 1]?.id
  }, [rows])
  /* Turn ordinals for the rewind dialog ("Turn 4"): the journal's list when
     present — it names withheld turns too — else the order on screen. The
     same numbering the rail shows. */
  const turnNumber = React.useMemo(() => {
    const byId = new Map<string, number>()
    if (thread.turns.length > 0) {
      thread.turns.forEach((t, i) => byId.set(t.turnId, i + 1))
    } else {
      let n = 0
      for (const item of thread.items) {
        if (item.kind === "user" && item.turnId && !byId.has(item.turnId)) byId.set(item.turnId, ++n)
      }
    }
    return byId
  }, [thread.turns, thread.items])
  /* The thread's true tail, read off `thread.items` rather than the rows: it is
     what "is this row the one still being written" is asked against. Every item
     is drawn — under `answersOnly` the newest is the tail of the fold that holds
     it — and `rowTailId` recurses through a fold, so exactly one row answers. */
  const last = thread.items[thread.items.length - 1]
  /* The rows still being written, by this reading — the newest one, and the
     group under a thought that is standing at the tail (`streamingRowIds`).
     Asked against the rows rather than `rowTailId` alone, because a trailing
     thought is outside the fold it explains and left the group above it
     folding shut every time the model started thinking. */
  const streamingRows = React.useMemo(
    () => (thread.turnActive ? streamingRowIds(rows, last?.id) : EMPTY_ROWS),
    [rows, last?.id, thread.turnActive]
  )
  /* A turn the agent's process ended under is resumable the same way: its row
     is the last thing that happened, and sending "Continue." revives the agent
     first (`ready`). Unlike an interrupt it stays offered beside a `failed`
     phase, because that phase is the same crash and its Revive is the other
     door to the same place. */
  const resumable =
    (last?.kind === "notice" && !thread.turnActive && thread.phase.kind !== "failed") ||
    (last?.kind === "error" && last.stopped && !thread.turnActive)
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

  /* ── Rewind ──
     Which finished turn the dialog is open for. The dialog confirms the scope
     and the action rebuilds from 0 after the server clears the journal. */
  const [rewindTarget, setRewindTarget] = React.useState<{
    turnId: string
    n: number
    text: string
  } | null>(null)
  const [rewindBusy, setRewindBusy] = React.useState(false)
  const agents = useAgents()
  const meta = useSessionMeta(sessionId)
  useVoiceCallLifetime(sessionId, !!meta?.deletedAt)
  /* A mention or file link opens in the project's Preview — inside this
     thread's dock when it has one (its `openPanel` keeps a preview there), the
     outer dock's otherwise. Null in a popout, which has no dock. */
  const dock = React.useContext(DockContext)
  const projectId = meta?.projectId ?? HOME_PROJECT_ID
  const projectRoot = useProjects().find((project) => project.id === projectId)?.cwd
  const worktree = meta?.worktree?.path
  const filePreview = React.useMemo<FilePreviewValue | null>(
    () =>
      dock
        ? {
            scope: { projectId, root: projectRoot, worktree },
            open: (file) =>
              dock.openPanel({ kind: "web", viewId: "default", projectId, file, diff: undefined }),
          }
        : null,
    [dock, projectId, projectRoot, worktree]
  )
  /* The agent's rewind door: absent/false = the conversation half is not
     offered on this thread, and files are restored on their own. Read off the
     catalog like every other agent capability — the server still refuses what
     it cannot do. */
  const canRewindConversation =
    agents.find((a) => a.id === meta?.agentId)?.rewindVia === "acp-fork-point"
  const confirmRewind = (scope: RewindScope) => {
    const target = rewindTarget
    if (!target) return
    setRewindBusy(true)
    actions
      .rewindThread(sessionId, target.turnId, scope)
      .then(() => setRewindTarget(null))
      .catch(() => {})
      .finally(() => setRewindBusy(false))
  }
  /* Fork needs the same door rewind's conversation half needs — a runtime
     that can cut at a message id — and costs this thread nothing: the branch
     is born loaded elsewhere, and this transcript does not move. Failures are
     recorded into this thread by the action, so the catch is a closed door. */
  const forkAt = (turnId: string) => {
    actions
      .forkThread(sessionId, turnId)
      .then((id) => navigateTo(threadPath(id)))
      .catch(() => {})
  }
  /* What an attachment on this thread would actually do — read once here
     because two surfaces need the same answer: the composer's chips forecast
     it, and an error row uses it to decide whether "Retry as file paths" would
     change anything. */
  const delivery = useAttachmentDelivery(meta, thread)
  /* Each row's handlers at one identity per row id, for the life of the view:
     fresh arrows per render were what made `RowView`'s memo ornamental, so every
     finished row re-rendered on every streamed token. They read the latest
     render's closures through `live` at click time. Which handlers a row is
     *offered* is still decided per render below — that only changes at turn
     boundaries. */
  const live = React.useRef({ rows, resume, retry, retryAsPaths, forkAt, turnNumber, sessionId })
  live.current = { rows, resume, retry, retryAsPaths, forkAt, turnNumber, sessionId }
  const handlerCache = React.useRef(new Map<string, RowHandlers>())
  const handlersFor = (id: string): RowHandlers => {
    let handlers = handlerCache.current.get(id)
    if (handlers) return handlers
    const row = () => live.current.rows.find((r) => r.id === id)
    handlers = {
      resume: () => live.current.resume(),
      rewind: () => {
        const r = row()
        if (r?.kind !== "user" || !r.turnId) return
        setRewindTarget({ turnId: r.turnId, n: live.current.turnNumber.get(r.turnId) ?? 0, text: r.text })
      },
      fork: () => {
        const r = row()
        if (r?.kind === "user" && r.turnId) live.current.forkAt(r.turnId)
      },
      retry: () => {
        const r = row()
        if (r?.kind === "error" && r.retryText) live.current.retry(r.retryText)
      },
      retryAsPaths: () => {
        const r = row()
        if (r?.kind === "error") live.current.retryAsPaths(r)
      },
      dismiss: () => dispatch({ type: "dismiss-error", id: live.current.sessionId, itemId: id }),
    }
    handlerCache.current.set(id, handlers)
    return handlers
  }
  /* The newest failure's doors, when the foot is standing in for its row: the
     same handlers `ErrorRow` is given, so the two cannot disagree. */
  const failedRow =
    status?.kind === "turn-failed"
      ? (thread.items.find((i) => i.id === status.itemId && i.kind === "error") as
          | Extract<ThreadItem, { kind: "error" }>
          | undefined)
      : undefined
  const onStatusAction = (kind: string, itemId?: string) => {
    if (!itemId) return
    const h = handlersFor(itemId)
    if (kind === "continue") h.resume()
    else if (kind === "retry") h.retry()
    else if (kind === "retryAsPaths") h.retryAsPaths()
    else if (kind === "dismiss") h.dismiss()
  }
  /* A picked suggestion fills the box with the kind's own words (`fill`: a
     follow-up as written, a command as its `!` line, a file as its `@` mention)
     — the same act the matching completer's pick is, and for the same reason:
     the line is read and edited before it goes anywhere, so nothing happens on
     the click. */
  const pickSuggestion = React.useCallback((text: string) => composerApiRef.current?.fill(text), [])
  /* The same door for a drawn answer: a generated view's button asks for words
     and they land in the box unsent, so it is the suggestion pick's contract
     rather than a second one. Memoised because the transcript re-renders per
     streamed token and a view should not be handed a new object each time. */
  const openuiActions = React.useMemo(() => ({ fill: pickSuggestion }), [pickSuggestion])
  /* Which transcript the keys belong to. The dock keeps every opened thread
     mounted and navigates the URL as tabs are activated (see workspace/dock), so
     the route is the app's own answer to "which one is in front". */
  const location = useLocation()
  /* The composer is a sibling of the transcript, so everything that puts words
     back in the box — the suggestion card, a queued message's Edit, Escape's
     take-back — goes through this handle rather than shared state. Declared
     above the keys because Escape is one of them. */
  const composerApiRef = React.useRef<ComposerHandle>(null)
  const inFront = useIsFrontPanel()
  const routed = inFront && currentThreadId(location.pathname, location.search) === sessionId
  useThreadKeys({
    sessionId,
    thread,
    actions,
    composer: composerApiRef,
    enabled: routed,
  })
  // Shared with the hero behind the whole inset, which the shell paints — the
  // two must agree about when this thread counts as empty. See lib/store.
  const empty = threadIsEmpty(thread, meta?.draft)
  /* Whether the composer sits centred under the welcome — an empty thread's
     layout — or docked at the foot, which a mini window always wants. */
  const centred = empty && !pinComposer
  /* Set only by the New tab page, whose draft this is (`landing-console.ts`). */
  const landing = React.useContext(LandingConsoleContext)
  /* The stand-in for a transcript that is on its way: opening, nothing folded
     yet, and not a draft (which has no transcript to wait for). Gated out here
     rather than inside the component because a `MessageScrollerItem` that
     renders nothing still reserves its intrinsic size. */
  const skeletonShown = !meta?.draft && thread.items.length === 0 && isOpening(thread.phase)

  /* The commands a thread may recommend are its project's own — the same union
     the `!` completer offers (saved helpers + package.json scripts, folded into
     `useProjects` and one query). A recommendation is filtered against this set
     before it is drawn (`SuggestKindDef.keep`), so a line that names nothing
     defined never becomes a command the user could click and watch fail. */
  const suggestionProject = useProjects().find((candidate) => candidate.id === meta?.projectId)
  const suggestionScripts =
    useProjectScripts(meta?.projectId ?? "", Boolean(meta?.projectId)).data ?? NO_SCRIPTS
  const definedCommands = React.useMemo(
    () =>
      new Set([
        ...(suggestionProject?.helpers ?? []).map((helper) => helper.command.trim()),
        ...suggestionScripts.map((script) => script.command.trim()),
      ]),
    [suggestionProject?.helpers, suggestionScripts]
  )
  /* Which finished answers get a suggestion card, keyed by the answer's own id
     — the same per-turn slot the sources and token footers occupy. The thread's
     set of kinds (a spawn bargain with the model, see lib/actions) is read here,
     so turning a kind off takes its cards away at once. A server that predates
     the set sends none, which reads as the default two. */
  const suggestKinds = meta?.suggestKinds ?? DEFAULT_SUGGEST_KINDS
  const suggestionsAfter = React.useMemo(
    () => withTurnSuggestions(thread.items, thread.turnActive, suggestKinds, { definedCommands }),
    [thread.items, thread.turnActive, suggestKinds, definedCommands]
  )
  const suggestionsFor = (row: Row): SuggestGroup[] | undefined =>
    suggestionsAfter.get(rowTailId(row))?.groups

  const rootRef = React.useRef<HTMLDivElement>(null)
  /* The aside open over this thread, if any — one at a time. */
  const [aside, setAside] = React.useState<AsideAt | null>(null)
  const closeAside = React.useCallback(() => setAside(null), [])
  /* ⌘/Ctrl on either door opens the aside as a tab, like any thread. */
  const openAside = React.useCallback((at: AsideAt, asTab: boolean) => {
    if (asTab) openInNewTab(threadPath(at.id)) || navigateTo(threadPath(at.id))
    else setAside(at)
  }, [])
  useAsideHighlights(rootRef, sessionId, openAside)
  const composerRef = React.useRef<HTMLDivElement>(null)

  /* ── The inspector ──
     A column of this panel, never a dock split (see thread-inspector). Where
     the *panel* is wide it is docked beside the transcript and whether it is
     open is the device's (`lib/inspector.ts`); where it is not, it is a sheet
     over the transcript and its open state is this view's alone — a stored
     overlay would cover every narrow transcript on the device. The width is
     measured on the panel, not the window: a chat beside a terminal is narrow
     on a wide screen. A hidden tab measures 0, which is "not on screen", not
     "narrow". */
  const inspector = inspectorPrefs.use()
  const [panelWidth, setPanelWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = (width: number) => {
      if (width > 0) setPanelWidth(width)
    }
    measure(root.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => measure(entry?.contentRect.width ?? 0))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  const wide = panelWidth >= INSPECTOR_WIDE
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const dockOpen = React.useContext(InspectorContext)
  const inspectorDocked = !docked && wide && inspector.open && !!meta
  const sheet = !docked && !wide && sheetOpen && !!meta
  const openInspector = React.useCallback(
    (tab?: InspectorTab) => {
      if (tab) setInspectorPref("tab", tab)
      if (wide) setInspectorPref("open", true)
      else setSheetOpen(true)
    },
    [wide]
  )
  /* The row a subagent is drawn in, for the Agents tab's jump: a nested group
     lives inside a run, a batch or a workflow, and only top-level rows are
     scroller items. */
  /* Through a ref, so its identity does not move per token: `PublishJump`'s
     effect and the inspector both depend on it. */
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const locate = React.useCallback(
    (id: string) => rowsRef.current.find((row) => rowContains(row, id))?.id,
    []
  )
  const closeInspector = React.useCallback(
    () => (inspectorDocked ? setInspectorPref("open", false) : setSheetOpen(false)),
    [inspectorDocked]
  )
  /* The rail's ticks are turn boundaries, which a streamed token never moves. */
  const railItems = React.useDeferredValue(visible)
  const ensureTurn = React.useCallback(
    (turnId: string, seq: number) => actions.loadUntilTurn(sessionId, turnId, seq),
    [actions, sessionId]
  )
  /* The docked composer is an overlay of unknown height — shelf rows, the
     queue, attachments and textarea growth all move it — so its pixel height
     is measured and published as `--composer-dock-h` on the grid root for the
     transcript to respect (content reserve, scroll-padding, button lift).
     Cleared while empty, where the composer is back in flow and no reserve
     is needed. */
  React.useLayoutEffect(() => {
    const root = rootRef.current
    const composer = composerRef.current
    if (!root || !composer || centred) {
      root?.style.removeProperty("--composer-dock-h")
      return
    }
    /* Once per settled height, not per frame of a shelf or checklist height
       transition: the variable is the transcript's padding and scroll-padding,
       so each frame of a 280ms slide used to re-lay out the scroller. The
       reserve lands when the slide does. */
    const publish = () => {
      const sliding = composer
        .getAnimations({ subtree: true })
        .filter((a) => a instanceof CSSTransition && a.transitionProperty === "height")
      if (sliding.length > 0) {
        void Promise.allSettled(sliding.map((a) => a.finished)).then(publish)
        return
      }
      root.style.setProperty("--composer-dock-h", `${composer.offsetHeight}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(composer)
    return () => observer.disconnect()
  }, [centred])

  return (
    /* Rows: transcript | composer | spacer. The spacer is 1fr while the thread
       is empty and 0fr once it is not, which centres the composer and then
       docks it. Not transitioned: the composer leaves the flow (absolute) on
       the same render, so it jumped anyway and the 500ms `grid-template-rows`
       tween only re-laid out the transcript every frame under it.
       minmax(0,…) on both flexible tracks, never a bare `1fr`: that is shorthand
       for minmax(auto,1fr), whose auto minimum lets a long transcript push the
       row taller than the thread and scroll the whole pane. */
    <OpenuiActionsContext.Provider value={openuiActions}>
    <MessageScrollerProvider autoScroll={options.autoScroll}>
    {/* The Provider sits at the grid root rather than around the transcript:
        the turn rail needs the scroller's `scrollToMessage`/`currentAnchorId`
        as much as the transcript does. The provider renders no DOM of its own
        — context only — so this changes nothing about the layout. */}
    <ThreadIdContext.Provider value={sessionId}>
    <JumpPrepProvider value={jumpPrep}>
    <FilePreviewContext.Provider value={filePreview}>
    <InspectorContext.Provider value={docked ? dockOpen : meta ? openInspector : null}>
    {docked && <PublishJump locate={locate} sessionId={sessionId} actions={actions} />}
    <div
      ref={rootRef}
      data-empty={centred || undefined}
      className={cn(
        "group/thread relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,0fr)] data-empty:grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]",
        inspectorDocked && "grid-cols-[minmax(0,1fr)_auto]"
      )}
    >
      {(inspectorDocked || sheet) && meta && (
        <>
          {sheet && (
            <button
              type="button"
              aria-label="Close the inspector"
              tabIndex={-1}
              /* A dim, not a blur: a backdrop filter over the whole scroller
                 re-blurs it every frame the transcript streams or scrolls. */
              className="absolute inset-0 z-30 bg-background"
              onClick={() => setSheetOpen(false)}
            />
          )}
          <ThreadInspector
            thread={lazyThread}
            meta={meta}
            changes={latestChanges}
            mode={inspectorDocked ? "docked" : "sheet"}
            onClose={closeInspector}
            locate={locate}
            maxWidth={panelWidth - INSPECTOR_TRANSCRIPT_MIN}
          />
        </>
      )}
      {/* `autoScroll` defaults to FALSE — without it the transcript never follows
           the stream. Every direct child of Content must be an Item with a
           `messageId`: the visibility/preservation scanner skips elements without
           one, so unkeyed items are invisible to the scroller.
           The primitive's own follow is kept (it is what hides the
           scroll-to-bottom button while following) but it is not trusted on its
           own — `useFollowStream` owns the pin. See hooks/use-follow-stream. */}
        <MessageScroller className="col-start-1 row-start-1 min-h-0 flex-1">
          <MessageScrollerViewport
            ref={follow.viewportRef}
            /* Measured dock height: the follow/scroll-into-view offset keeps
               the live tail landing above the glass. Falls back while the
               first measurement lands. The top padding is the floating app
               header: it scrolls away with the transcript (padding inside a
               scroller does), so the first message starts below the header
               and everything after it passes beneath the header's blur; the
               scroll-padding keeps a jump-to-message landing there too rather
               than hidden under it. */
            /* `--dock-content-overlap` is how much of *this panel* the floating
               header actually covers, measured per group by workspace/dock-header.ts
               — zero for a thread in a group that is not at the top. The
               constant is the fallback: outside the dock (and for the frame
               before the first measurement) it is the whole header. */
            /* The gutter that keeps this column centred on the *panel* — and so
               on the composer, which is centred outside the scroller — is the
               viewport's own (`MessageScrollerViewport`, which is why it is not
               spelled here: two declarations of it raced, and the caller's
               lost). */
            className={cn(
              "pt-[var(--dock-content-overlap,var(--app-header-h))] [scroll-padding-top:var(--dock-content-overlap,var(--app-header-h))]",
              !centred && "[scroll-padding-bottom:var(--composer-dock-h,14rem)]"
            )}
          >
            <LayoutOptionsContext.Provider value={options}>
            <StepTokensProvider value={stepTokens}>
            <DormancyProvider value={dormancy}>
            <RowMemoryContext.Provider value={rowMemory}>
            <MessageScrollerContent
              ref={follow.contentRef}
              data-density={options.compactDensity ? "compact" : undefined}
              data-wrap={options.codeWrap ? "on" : undefined}
              data-motion={options.calmMotion ? "calm" : undefined}
              className={cn(
              "thread-transcript mx-auto w-full gap-0.5 px-4 py-4",
                options.compactDensity && "gap-0 py-2",
                options.wideTranscript ? "max-w-[82rem]" : "max-w-[var(--harness-chat-width)]",
                /* Scrollable reserve — the measured dock height and no more.
                   It used to carry a spare `+1rem` on top, which no other
                   reading of the dock had (`scroll-padding-bottom` and the
                   scroll-to-end lift are both the height alone), so the foot of
                   a live thread rested 16px clear of the shelf with nothing
                   between them to explain it. The last item is already a `py-1`
                   wrapper in the foot, and that is the gap. */
                !centred && "pb-[var(--composer-dock-h,13rem)]",
              )}
            >
              {/* A stand-in while the transcript is being read — and only then:
                  an opening thread with nothing folded yet, never a draft, and
                  gone the instant the first row lands. That gate is what makes
                  it not the old unconditional skeleton, which claimed a shape
                  for content nobody had seen yet. The sidebar row still says
                  "connecting" — see AppShell.
                  The empty state is not in here either: it sits with the
                  composer in the middle row, so the greeting and the box you
                  type into travel to the bottom together. */}
              {skeletonShown && (
                <MessageScrollerItem messageId="skeleton">
                  <ThreadSkeleton />
                </MessageScrollerItem>
              )}
              {/* The transcript begins in the middle: this thread was long
                  enough that the server sent only its tail. The rest is still
                  there and comes back a page at a time. */}
              {thread.earlier > 0 && (
                <MessageScrollerItem messageId="earlier">
                  <div
                    ref={earlierRef}
                    className="mb-2 flex items-center justify-center gap-2 text-muted-foreground"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      loading={thread.loadingEarlier}
                      onClick={loadEarlier}
                    >
                      <ChevronUp data-icon="inline-start" />
                      Load earlier steps
                    </Button>
                    <span className="text-xs">{thread.earlier} earlier step{thread.earlier === 1 ? "" : "s"}</span>
                  </div>
                </MessageScrollerItem>
              )}
              {rows.map((row, i) => {
                /* A hairline above each of your messages (except the first)
                    separates one turn from the next when Turn dividers is on —
                    and above whatever first follows a workflow run that has
                    ended, so the run is closed off from what the thread did
                    next. One line either way: a run's rule is not doubled by a
                    turn divider. */
                const isUser = row.kind === "user"
                const divider =
                  separatorAfterRun(rows, i) || (options.stepDividers && isUser && i !== firstUserIndex)
                /* Messages sent back to back (steers, a queue draining) read as
                   one run: only its last says the time, like a chat's grouped
                   bubbles — a clock under each said the same minute four times. */
                const runContinues = isUser && rows[i + 1]?.kind === "user"
                const handlers = handlersFor(row.id)
                const finishedUserTurn =
                  row.kind === "user" && !!row.turnId && !row.local && !thread.turnActive
                return (
                /* ponytail: no scrollAnchor. Anchoring the user's message to
                    the top of the viewport meant sending scrolled the whole
                    transcript up and left a blank screen until the agent
                    produced enough output to fill it back in. Autoscroll alone
                    keeps the newest content in view without the jump. */
                /* Off-screen rows skip layout through `MessageScrollerItem`'s
                    own `content-visibility: auto`, streaming or not. It used to
                    be toggled per row on turn start/end (`data-settled`), which
                    restyled every row of the thread at the moment of Send —
                    and the primitive's class had it on all along anyway.
                    `contain-intrinsic-size: auto` remembers each row's last
                    real height, and only the on-screen tail grows, so the
                    autoscroll target does not drift. */
                /* `-mx-2 px-2`: `content-visibility: auto` is paint
                    containment, which clips to the item's box — and step rows
                    hang their hover ground 4px past it on both sides, while a
                    parallel group's wash hangs 8px past. The room is the widest
                    bleed, not the usual one: at 4px the wash's own ring survived
                    on the top and bottom edges only, so a batch read as a box
                    sliced off at the sides. */
                <MessageScrollerItem key={row.id} messageId={row.id} className="-mx-2 px-2">
                  {/* Everything the row draws sits in one box that can go
                      dormant once the row is settled history — see dormant.tsx.
                      The item itself stays, in flow, at its height. */}
                  <Dormant eligible={i < settledBefore}>
                  {/* No `first:hidden`: the divider is always its item's first
                      child, so that hid every one. `firstUserIndex` already
                      skips the first turn. */}
                  {divider && <div aria-hidden className="my-2 h-px bg-border" />}
                  {/* The wait between the last tool settling and the reply
                      starting to be written: prose ends its run, so the run's
                      own step gaps (`layoutBatches`) never reach it. */}
                  {(() => {
                    const floor = gapMinMs(options.gapMin)
                    if (floor === null) return null
                    const wait = proseGapAfter(rows, i)
                    return wait !== undefined && wait > 0 && wait >= floor ? <StepGap ms={wait} /> : null
                  })()}
                  {/* The entrance wrapper (index.css): one per row, so the
                      divider and the Sources strip sit beside it — each mounts
                      at its own moment and rises in on its own.

                      The `stagger` numbers below are this row's footer read top
                      to bottom, and they are hand-written because that is what
                      they are: five fixed slots, not a list. They cost nothing
                      in the case they mostly run in — the answer mounts alone,
                      long before the turn ends, so its 0 is the only one asked
                      for. They earn themselves at the two moments the footer
                      arrives *together*: the end of a turn, when sources, the
                      token figure, the changes chip and the follow-ups all
                      resolve on one frame, and a replay, where the whole row is
                      one mount. Both used to land as a single block. */}
                  <Entrance animate={animateEntrance && i >= freshFrom}>
                    <RowView
                      row={row}
                      onContinue={resumable === row.id ? handlers.resume : undefined}
                      onRewind={finishedUserTurn && !meta?.parentSessionId ? handlers.rewind : undefined}
                      /* No dialog: there is no scope to pick — a fork never
                         touches this thread. Gated on the agent's door rather
                         than the parent check rewind carries, because a
                         branch of a workflow step is allowed to be its own
                         thread where a rewind of one is not allowed at all. */
                      onFork={finishedUserTurn && canRewindConversation ? handlers.fork : undefined}
                      onRetry={row.kind === "error" && row.retryText ? handlers.retry : undefined}
                      /* Offered only when something on that turn would actually
                         have been inlined — a turn whose files all went as paths
                         already failed for some other reason, and a button that
                         changes nothing is worse than no button. Read through
                         the same `resolveDelivery` the chip's note and the
                         bridge's branch use. */
                      onRetryAsPaths={
                        row.kind === "error" && wentInline(row, delivery) ? handlers.retryAsPaths : undefined
                      }
                      onDismiss={row.kind === "error" ? handlers.dismiss : undefined}
                      /* The newest failure is the foot's own while it is live;
                         older ones are history and stay whole rows. */
                      compactError={status?.kind === "turn-failed" && status.itemId === row.id}
                      showTimestamps={options.showTimestamps && !runContinues}
                      streaming={streamingRows.has(row.id)}
                    />
                  </Entrance>
                  <TurnFooter
                    sources={options.showSources ? sourcesFor(row) : undefined}
                    usage={options.showTokens ? usageFor(row) : undefined}
                    durationMs={durationFor(row)}
                    toolDurationMs={toolDurationFor(row)}
                    generation={generationFor(row)}
                    calls={callsFor(row)}
                    suggestions={suggestionsFor(row)}
                    onPick={pickSuggestion}
                  />
                  </Dormant>
                </MessageScrollerItem>
                )
              })}
              {/* One slot for what the thread says about itself — the
                  connection, an archived stop, the opening wait, the working
                  line (`statusFor` is the ladder, in the order the four rows
                  here used to gate each other). It sits at the FOOT, where the
                  next thing happens: a replay arrives oldest-first and the
                  scroller is pinned to the bottom. The failure-held card, the
                  approvals and the queue below keep their own rows. */}
              {/* `-ms-3 ps-3` on the status item: `.harness-status` hangs its
                  tone rule 10px left of its box, and the item's paint
                  containment would clip it. No `mt-auto`: the line is the
                  newest of the thread's events and follows them, rather than
                  resting on the composer with blank paper above it. */}
              {status && (
                <MessageScrollerItem messageId="status" className="-ms-3 ps-3">
                  <div
                    className={status.tone === "progress" && status.opening ? undefined : "harness-item-in"}
                    style={stagger(0)}
                  >
                    <div className="py-1">
                      <ThreadStatus
                        status={status}
                        sessionId={sessionId}
                        actions={actions}
                        onAction={onStatusAction}
                        canRetryAsPaths={failedRow ? wentInline(failedRow, delivery) : false}
                      />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
              {/* The three things that stop a turn dead, at the tail of the
                  flow where the turn is: an approval, a question and a turn
                  held on a failure are the same event to a reader — the agent
                  has got as far as it can and is waiting on you — so they are
                  drawn on the same card. All come after the working line:
                  whatever the agent got as far as saying is above the thing it
                  stopped on. */}
              {hold.byError && (
                <MessageScrollerItem messageId="held">
                  <div className="harness-item-in" style={stagger(3)}>
                    <div className="py-1">
                      <InlineHeldTurn sessionId={sessionId} actions={actions} thread={thread} />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
              {thread.permissions.map((pending, index) => (
                <MessageScrollerItem
                  key={pending.requestId}
                  messageId={`permission:${pending.requestId}`}
                >
                  {/* Continuing the foot's count rather than restarting it, and
                      the one place here that is a real list: two approvals
                      arriving at once are two rows, so they cascade past each
                      other the way a run's steps do. */}
                  <div className="harness-item-in" style={stagger(4 + index)}>
                    <div className="py-1">
                      {pending.from && <AskedBy from={pending.from} />}
                      <InlineApproval
                        permission={pending}
                        item={thread.items.find(
                          (i): i is ToolItem =>
                            i.kind === "tool" && i.id === pending.request.toolCall.toolCallId
                        )}
                        autofocus={index === 0}
                      />
                    </div>
                  </div>
                </MessageScrollerItem>
              ))}
              {/* The card rides the soft keyboard while a field within it is
                  being answered. It is the transcript's live tail, resting on
                  the margin above the docked composer — so when the composer
                  lifts for the keyboard, its glass would slide up over the
                  very input being typed into. `KEYBOARD_LIFT_FOCUSED` lifts
                  the card by the same inset while it has focus, so it clears
                  the lifted glass and the keys together, and settles back the
                  moment it does not. A transform, so the transcript itself
                  never moves with it. */}
              {thread.elicitations.map((pending) => (
                <MessageScrollerItem
                  key={pending.requestId}
                  messageId={`elicitation:${pending.requestId}`}
                  className={KEYBOARD_LIFT_FOCUSED}
                >
                  <div className="harness-item-in">
                    <div className="py-1">
                      {pending.from && <AskedBy from={pending.from} />}
                      <InlineElicitation elicitation={pending} />
                    </div>
                  </div>
                </MessageScrollerItem>
              ))}
              {/* Last, and last on purpose: a queued message is the *future* of
                  this conversation. Everything above it has happened or is
                  happening — the working line, the approval, the question the
                  turn stopped on — and these are the sentences that go next, so
                  they sit where they will land, at the end, until they are
                  sent. Editing one takes it back to the composer, which is why
                  there is no editor here.

                  Gated outside the component: a `MessageScrollerItem` that
                  renders nothing still reserves `contain-intrinsic-size`. */}
              {/* The settings change the thread is carrying rides with the
                  queue: both are what the conversation is *about to be* on,
                  and the transcript is where that is read. Above the queue,
                  because the queue is the sentences and this is the context
                  they will be sent in. Gated outside the item, which renders
                  nothing yet still reserves `contain-intrinsic-size`. */}
              {(thread.pendingConfig || thread.stagedConfig) && (
                <MessageScrollerItem messageId="pending-settings">
                  <div className="py-1">
                    <PendingSettings thread={thread} sessionId={sessionId} actions={actions} />
                  </div>
                </MessageScrollerItem>
              )}
              {thread.queue.length > 0 && (
                <MessageScrollerItem messageId="queue" className="-mx-1 px-1">
                  <div className="py-1">
                    <ComposerQueue
                      sessionId={sessionId}
                      thread={thread}
                      actions={actions}
                      onEdit={(text) => composerApiRef.current?.fill(text)}
                    />
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
            </RowMemoryContext.Provider>
            </DormancyProvider>
            </StepTokensProvider>
            </LayoutOptionsContext.Provider>
          </MessageScrollerViewport>
          {/* The primitive's own scroll-to-end runs on click; re-pinning here as
              well is what makes the button mean "and keep up from now on"
              instead of "put me at the bottom once". */}
          {!centred && <ScrollToEnd pinned={follow.pinned} onClick={follow.follow} />}
          {/* The turn rail: one tick per turn, riding the transcript's left
              edge as an absolute overlay, centred in the view — a sibling of
              the viewport, so it does not scroll with the content. Under the
              reader's Turn rail toggle, and the rail draws nothing under two
              turns, so a short thread pays for it only in a hook call. */}
          {options.turnRail && railItems.length > 0 && (
            <ThreadRail
              items={railItems}
              turns={thread.turns}
              onEnsureTurn={ensureTurn}
            />
          )}
        </MessageScroller>
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
      {/* Docked once the thread is live: the composer leaves the grid flow and
          overlays the transcript's foot (absolute against the grid root above,
          which is `relative`), so thread content scrolls under the frosted
          card. The row it vacated collapses and the viewport takes the full
          height. `pointer-events-none` keeps the full-width band from eating
          transcript clicks — the composer's own root re-enables them. While
          empty the composer stays in flow, centred by the grid rows above. */}
      {/* Docked, it rides the soft keyboard: nothing else on the screen moves
          when one opens (index.html asks for `overlays-content`), and this is
          the surface that would otherwise be under it — absolute against a
          panel that does not scroll, so the browser has nothing to scroll
          into view either. A transform rather than a `bottom`, so the height
          the transcript reserves (`--composer-dock-h`, measured from
          offsetHeight) does not move with it and the transcript stays exactly
          where the reader left it. An empty thread rides the same way: the
          composer is back in flow and centred, but nothing around it scrolls
          either, so the browser's own scroll-into-view has nothing to move
          and the keyboard would cover it just the same. By half, though:
          the grid rows centre the box, so its middle already sits at
          mid-pane — the keyboard covers the bottom `k`, and staying centred
          in what is left above it means rising by `k/2`, not `k`
          (`KEYBOARD_CENTER_FLOW`). A full `KEYBOARD_LIFT` here would push
          the welcome past centre and, on a short pane, out the top.

          The transition is the platform's own animation, copied: 285ms on
          `cubic-bezier(0.2, 0, 0, 1)` are Android's ANIMATION_DURATION_SYNC_IME_MS
          and SYNC_IME_INTERPOLATOR (AOSP `InsetsController`). It has to be
          copied because it cannot be followed — the per-frame keyboard
          position lives in `WindowInsetsAnimation.Callback.onProgress`, which
          Chromium consumes for its own Java UI and never plumbs into the
          renderer, so `--keyboard-inset` arrives once, whole, as the keyboard
          starts moving (Android dispatches the final insets at animation
          start once a callback is registered). Animating from that one value
          on the same curve is as close to in step as a page can get; the
          slower dismiss (340ms) is not matched, which would take script to
          tell an open from a close. `translate` so it stays on the
          compositor. */}
      <div
        ref={composerRef}
        className={cn(
          "col-start-1 row-start-2 min-w-0",
          centred ? KEYBOARD_CENTER_FLOW : KEYBOARD_LIFT,
          centred
            ? "relative"
            : cn(
                "pointer-events-none absolute bottom-0 z-20",
                /* Docked beside the inspector, the overlay stops at its edge —
                   the column publishes its live width (drag included) as
                   `--inspector-w` on this grid root. */
                inspectorDocked ? "left-0 right-[var(--inspector-w,20rem)]" : "inset-x-0"
              ),
        )}
      >
        {centred && <ThreadWelcome draft={meta?.draft} landing={!!landing} />}
        <Composer
          ref={composerApiRef}
          sessionId={sessionId}
          actions={actions}
          thread={lazyThread}
          meta={meta}
          delivery={delivery}
          changes={latestChanges}
          voiceCall
          autoFocus={landing ? true : undefined}
          beforeSend={landing?.beforeSend}
          /* Once the thread has started the box *may* be the mini one
             (`compact`), which is the reader's own switch (View options › Mini
             composer, off by default); with it on, they open the advanced form
             with its toggle, and off, the full box is simply the box.
             Scroll away from the tail and an advanced box folds back to mini:
             `follow.pinned` is false once a gesture has taken the reader away —
             the same state the scroll-to-end button draws — and reaching the
             bottom re-pins. Nothing is ever hidden behind a button of its own,
             and it never collapses on a narrow panel or a short window, which
             took the box from somebody who was typing. An empty thread (a
             draft, the landing console, which has no scroller to ask) is the
             full box: that is where the first message is written. */
          compact={!empty}
          collapsed={!follow.pinned}
          onSend={options.autoScroll ? follow.follow : undefined}
        />
      </div>
      <QuoteSelection
        rootRef={rootRef}
        onQuote={(text) => composerApiRef.current?.quote(text)}
        /* A draft has no row to link an aside to. */
        onAside={
          meta && !meta.draft
            ? (text, x, y, asTab) => {
                const id = actions.startAside(sessionId, text)
                if (id) openAside({ id, x, y }, asTab)
              }
            : undefined
        }
      />
      {aside && <AsideWindow at={aside} actions={actions} onClose={closeAside} />}
      {/* The spacer that collapses. Nothing renders in it — its whole job is to
          be the bottom half of the centring while the thread is empty. */}
      <div className="col-start-1 row-start-3 min-w-0">{centred && landing?.strip}</div>
    </div>
    </InspectorContext.Provider>
    </FilePreviewContext.Provider>
    </JumpPrepProvider>
    </ThreadIdContext.Provider>
    {rewindTarget && (
      <RewindDialog
        open={rewindTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rewindBusy) setRewindTarget(null)
        }}
        turnLabel={rewindTarget.n > 0 ? `Turn ${rewindTarget.n}` : "this turn"}
        turnPreview={rewindTarget.text}
        canRewindConversation={canRewindConversation}
        /* A files restore needs a start snapshot: the chip the transcript
           draws for reviewed changes reads the same store slice
           (`turnChanges`). Measured files prove a snapshot exists; an unknown
           turn reads as available, with the server's 404 as the honest
           fallback — a wrongly-disabled row blocks a rewind that works, while
           a wrongly-enabled one just surfaces the refusal in-thread. */
        hasFiles={(() => {
          const changes = thread.turnChanges[rewindTarget.turnId]
          if (!changes) return true
          if (changes.files.length > 0) return true
          return !changes.unavailable
        })()}
        defaultScope={canRewindConversation ? "both" : "files"}
        busy={rewindBusy}
        onConfirm={confirmRewind}
      />
    )}
    </MessageScrollerProvider>
    </OpenuiActionsContext.Provider>
  )
}

/** Hands the thread dock this transcript's scroll-to-row, so the Agents panel
    can jump a transcript it is not inside. A component because the scroller's
    hook only answers under `MessageScrollerProvider`, which `ThreadView`
    itself renders. */
function PublishJump({
  locate,
  sessionId,
  actions,
}: {
  locate: (id: string) => string | undefined
  sessionId: string
  actions: Actions
}) {
  const target = React.useContext(ThreadJumpContext)
  const scrollToMessage = useTranscriptJump()
  React.useEffect(() => {
    if (!target) return
    target.current = (id, turn) => {
      const jump = (targetId: string) => {
        const row = locate(targetId)
        if (row) scrollToMessage(row, { align: "start", behavior: "smooth" })
      }
      if (turn) {
        void actions.jumpToTurn(sessionId, turn.turnId, turn.seq).then((loadedId) => {
          if (!loadedId) return
          requestAnimationFrame(() => requestAnimationFrame(() => jump(loadedId)))
        })
        return
      }
      if (id) jump(id)
    }
    return () => {
      target.current = null
    }
  }, [target, locate, scrollToMessage, actions, sessionId])
  return null
}

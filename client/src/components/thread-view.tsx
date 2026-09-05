import * as React from "react"
import type * as acp from "@daedalus/acp"
import { ChevronUp, GitCompare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Logo } from "@/components/ui/logo"
import { ActivityIndicator } from "@/components/composer-status"
import { useAttachmentDelivery, wentInline } from "@/components/composer-attachments"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useHotkey } from "@/hooks/use-hotkey"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { holdOf } from "@/lib/thread/hold"
import { slowLine, startingLine, type ConnPhase } from "@/lib/thread/phase"
import { currentThreadId } from "@/lib/router"
import { KEYS, isInteractiveTarget, isTypingTarget, overlayOpen } from "@/lib/shortcuts"
import { useDispatch, useSessionMeta, useThread, threadIsEmpty, type ThreadItem, type ThreadState } from "@/lib/store"
import { useLocation } from "react-router"
import { useViewOptions, ViewOptionsContext } from "@/lib/view-options"
import { useFollowStream } from "@/hooks/use-follow-stream"
import { cn } from "@/lib/utils"
import { StepTokensProvider, TokenSummary } from "./token-usage"
import { useDock } from "@/components/workspace/dock"
import { requestIde } from "@/lib/ide/open"
import { useServer } from "@/lib/server-context"
import { sessionChanges, type TurnChanges } from "@/lib/workspace/git-api"
import { InlineElicitation } from "./elicitation-form"
import { InlineApproval, primaryPermissionOption } from "./tool-approval"
import { InlineHeldTurn } from "./held-turn"
import { RowView, SourcesStrip } from "./thread-items"
import { splitTurns, turnSources, type TurnSources } from "@/lib/sources"
import { buildRows, isAnswerItem, rowTailId, type Row } from "@/lib/transcript-rows"
import { PromptSuggestions } from "./prompt-suggestions"
import { turnSuggestions } from "@/lib/suggestions"
import { Composer, type ComposerHandle } from "./composer"

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

/** What each finished turn took, keyed by the row it ends on — the same walk
    as `withTurnUsage`, the denominator the footer's tok/s is drawn against. A
    turn that ended before the server measured durations simply has no entry,
    and the footer draws tokens with no speed. */
function withTurnDuration(
  items: ThreadItem[],
  turnActive: boolean,
  turnDuration: Record<string, number>,
  answersOnly: boolean
): Map<string, number> {
  const after = new Map<string, number>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, answersOnly)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const durationMs = turnId ? turnDuration[turnId] : undefined
    if (durationMs !== undefined) after.set(tailId, durationMs)
  }
  return after
}

/** What each finished turn did to the worktree, keyed by the row it ends on
    — same walk as `withTurnUsage`, same footer slot. A turn that changed
    nothing (or was not measured) draws nothing. */
function withTurnChanges(
  items: ThreadItem[],
  turnActive: boolean,
  turnChanges: Record<string, TurnChanges>,
  answersOnly: boolean
): Map<string, TurnChanges> {
  const after = new Map<string, TurnChanges>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, answersOnly)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const changes = turnId ? turnChanges[turnId] : undefined
    if (changes && changes.ended && changes.files.length > 0) after.set(tailId, changes)
  }
  return after
}

/** Each finished turn's suggestion card, keyed by the id of the answer that
    carries it — the same walk and the same finished-turn gating as the footers
    above: the last turn only qualifies once it has ended, so a card never
    grows under the cursor mid-answer. Off when the thread's suggestions toggle
    is off (`meta.suggestFollowups`) — the toggle is the thread's ask, and the
    model's willingness to deliver the fence is read per answer by
    `turnSuggestions`. */
function withTurnSuggestions(
  items: ThreadItem[],
  turnActive: boolean,
  enabled: boolean
): Map<string, { itemId: string; prompts: string[] }> {
  const after = new Map<string, { itemId: string; prompts: string[] }>()
  if (!enabled) return after
  for (const { turn } of finishedTurns(items, turnActive)) {
    const entry = turnSuggestions(turn)
    if (entry) after.set(entry.itemId, entry)
  }
  return after
}

/** The chip's two halves: bring the IDE panel up, and ask it for the turn.
    `requestIde` writes the tab into the IDE's own store, so the order does not
    matter and a first-ever open works the same as one into a panel that is
    already there. Git's count, not the transcript's — a shell command that
    edited a file is in it, an edit tool that declared one is in it once. */
function openTurnChanges(
  dock: ReturnType<typeof useDock>,
  sessionId: string,
  projectId: string | undefined,
  scope: string
): void {
  if (!projectId) return
  dock.openPanel({ kind: "ide", projectId }, { direction: "right" })
  requestIde({ kind: "changes", projectId, sessionId, scope })
}

function TurnChangesChip({
  sessionId,
  projectId,
  turn,
}: {
  sessionId: string
  projectId: string | undefined
  turn: TurnChanges
}) {
  const dock = useDock()
  const added = turn.files.reduce((n, f) => n + f.additions, 0)
  const removed = turn.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <button
      type="button"
      onClick={() =>
        openTurnChanges(dock, sessionId, projectId, `turn:${turn.turnId}`)
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title="Review this turn's changes"
    >
      <GitCompare className="size-3" />
      {turn.files.length} {turn.files.length === 1 ? "file" : "files"} changed
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      <span className="text-red-600 dark:text-red-400">−{removed}</span>
    </button>
  )
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
  const hold = holdOf(thread)
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
  const durationAfter = React.useMemo(
    () => withTurnDuration(thread.items, thread.turnActive, thread.turnDuration, options.answersOnly),
    [thread.items, thread.turnActive, thread.turnDuration, options.answersOnly]
  )
  const durationFor = (row: Row): number | undefined => durationAfter.get(rowTailId(row))
  const changesAfter = React.useMemo(
    () => withTurnChanges(thread.items, thread.turnActive, thread.turnChanges, options.answersOnly),
    [thread.items, thread.turnActive, thread.turnChanges, options.answersOnly]
  )
  const changesFor = (row: Row): TurnChanges | undefined => changesAfter.get(rowTailId(row))
  /* The per-turn rows are the server's and live-only on the socket, so a
     transcript opened cold seeds them once here. Failure is silence: the
     chips are ambient, and a thread with no project has nothing to read. */
  const settings = useServer()
  React.useEffect(() => {
    const controller = new AbortController()
    sessionChanges(settings, sessionId, controller.signal)
      .then(({ turns }) => dispatch({ type: "turn-changes-all", id: sessionId, turns }))
      .catch(() => {})
    return () => controller.abort()
  }, [settings, sessionId, dispatch])
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

  /* Which finished answers get a suggestion card, keyed by the answer's own id
     — the same per-turn slot the sources and token footers occupy. The thread's
     toggle (a spawn bargain with the model, see lib/actions) is read here, so
     turning suggestions off takes every card away at once. */
  const suggestionsAfter = React.useMemo(
    () => withTurnSuggestions(thread.items, thread.turnActive, meta?.suggestFollowups === true),
    [thread.items, thread.turnActive, meta?.suggestFollowups]
  )
  const suggestionsFor = (row: Row): { itemId: string; prompts: string[] } | undefined =>
    suggestionsAfter.get(rowTailId(row))

  const rootRef = React.useRef<HTMLDivElement>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)
  /* The suggestion card's one way back into the box: it lives in the
     transcript, the box is a sibling — the fill goes through the composer's
     imperative handle rather than a shared "composer text" store. */
  const composerApiRef = React.useRef<ComposerHandle>(null)
  /* The docked composer is an overlay of unknown height — shelf rows, the
     queue, attachments and textarea growth all move it — so its pixel height
     is measured and published as `--composer-dock-h` on the grid root for the
     transcript to respect (content reserve, scroll-padding, button lift).
     Cleared while empty, where the composer is back in flow and no reserve
     is needed. */
  React.useLayoutEffect(() => {
    const root = rootRef.current
    const composer = composerRef.current
    if (!root || !composer || empty) {
      root?.style.removeProperty("--composer-dock-h")
      return
    }
    const publish = () => {
      root.style.setProperty("--composer-dock-h", `${composer.offsetHeight}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(composer)
    return () => observer.disconnect()
  }, [empty])

  return (
    /* Rows: transcript | composer | spacer. The spacer is 1fr while the thread
       is empty and 0fr once it is not, which centres the composer and then
       docks it — `fr` interpolates, so that whole move is one transition on one
       property with nothing measured in JS.
       minmax(0,…) on both flexible tracks, never a bare `1fr`: that is shorthand
       for minmax(auto,1fr), whose auto minimum lets a long transcript push the
       row taller than the thread and scroll the whole pane. */
    <MessageScrollerProvider autoScroll={options.autoScroll}>
    {/* The Provider sits at the grid root rather than around the transcript:
        the rail lives in the composer card now, and it needs the scroller's
        `scrollToMessage`/`currentAnchorId` as much as the transcript does.
        The provider renders no DOM of its own — context only — so this
        changes nothing about the layout. */}
    <div
      ref={rootRef}
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
        <MessageScroller className="min-h-0 flex-1">
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
               header actually covers, measured per group by workspace/dock.tsx
               — zero for a thread in a group that is not at the top. The
               constant is the fallback: outside the dock (and for the frame
               before the first measurement) it is the whole header. */
            className={cn(
              "pt-[var(--dock-content-overlap,var(--app-header-h))] [scroll-padding-top:var(--dock-content-overlap,var(--app-header-h))]",
              !empty && "[scroll-padding-bottom:var(--composer-dock-h,14rem)]"
            )}
          >
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
                /* Scrollable reserve matching the measured dock height, plus a
                   breath of room, so the last message rests above the glass
                   instead of behind it. */
                !empty && "pb-[calc(var(--composer-dock-h,13rem)+1rem)]",
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
                      <TokenSummary usage={usageFor(row)!} label="This turn" durationMs={durationFor(row)} />
                    </div>
                  )}
                  {changesFor(row) && (
                    <div className="harness-item-in mt-1">
                      <TurnChangesChip sessionId={sessionId} projectId={meta?.projectId} turn={changesFor(row)!} />
                    </div>
                  )}
                  {/* The model's closing follow-ups, under the answer that
                      suggested them. Deliberately NOT on the composer dock: the
                      dock is for state being typed with the turn, and next
                      actions belong where the reader is when they arrive — in
                      the same footer slot Sources and the token figure use. A
                      click fills the composer (replaced, unsent, focused) via
                      its imperative handle, so the box stays the box's own
                      state. */}
                  {suggestionsFor(row) && (
                    <div className="harness-item-in mt-1">
                      <PromptSuggestions
                        suggestions={suggestionsFor(row)!.prompts}
                        onPick={(prompt) => composerApiRef.current?.fill(prompt)}
                      />
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
                  as progress. Reaching `live` hands the wait back here.
                  Suppressed again for a turn held on a failure, for the same
                  reason from the other end: the card below says the same
                  sentence with the buttons that act on it, and a line above it
                  repeating the reason is the wait announced twice. A *user's*
                  pause keeps the line, because it has no card. */}
              {thread.turnActive && !startingLine(thread.phase) && !hold.byError && (
                <MessageScrollerItem messageId="working">
                  <div className="harness-item-in">
                    <div className="py-0.5">
                      <ActivityIndicator thread={thread} />
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
                  <div className="harness-item-in">
                    <div className="py-1">
                      <InlineHeldTurn sessionId={sessionId} actions={actions} thread={thread} />
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
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
          {/* Lifted above the docked composer while the thread is live, so the
              button never parks behind the glass. The lift repeats the base's
              `data-[direction=end]:` variant — an unprefixed `bottom-*` would
              survive the merge but lose to it on specificity. `z-30` keeps it
              painting above the composer's `z-20`. */}
          <MessageScrollerButton
            onClick={follow.follow}
            className={cn(
              !empty &&
                "z-30 data-[direction=end]:bottom-[calc(var(--composer-dock-h,14rem)+1rem)]",
            )}
          />
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
          and the keyboard would cover it just the same.

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
          "min-w-0 translate-y-[calc(var(--keyboard-inset,0px)*-1)] transition-[translate] duration-[285ms] ease-[cubic-bezier(0.2,0,0,1)] will-change-transform motion-reduce:transition-none",
          empty
            ? "relative"
            : "pointer-events-none absolute inset-x-0 bottom-0 z-20",
        )}
      >
        {empty && <ThreadWelcome draft={meta?.draft} />}
        <Composer
          ref={composerApiRef}
          sessionId={sessionId}
          actions={actions}
          thread={thread}
          meta={meta}
          delivery={delivery}
          railItems={visible}
          railTurns={thread.turns}
          onEnsureTurn={(turnId, seq) => actions.loadUntilTurn(sessionId, turnId, seq)}
          showRail={options.turnRail}
        />
      </div>
      {/* The spacer that collapses. Nothing renders in it — its whole job is to
          be the bottom half of the centring while the thread is empty. */}
      <span aria-hidden />
    </div>
    </MessageScrollerProvider>
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
      {/* The same mark and layout as the working line (`ActivityIndicator`):
          spawning, restarting and connecting are the thread being worked on,
          and the reader should not have to learn a second shape for the wait. */}
      <div className="flex min-w-0 items-center gap-2 text-primary" role="status">
        <Logo working className="size-4 shrink-0" />
        <span className="harness-shimmer min-w-0 truncate text-xs leading-6">{line.text}</span>
      </div>
      {bar ? (
        <div className="flex max-w-xs items-center gap-2 pl-6 pt-1.5">
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
        slowText && <div className="pl-6 pt-1 text-xs text-muted-foreground">{slowText}</div>
      )}
    </div>
  )
}

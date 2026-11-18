/* ── What a finished turn is worth ── the per-turn derivations the transcript
   hangs off the row each turn ends on: its sources, its cost, how long it
   took, what it did to the worktree, the follow-ups it offered, and the split
   a step's own popover reads. All pure reads of `thread.items` — a reading of
   the transcript, never a change to one — so they live apart from the surface
   in `thread-view.tsx` (and the inspector, for the Changes timeline).

   One exception, and it is deliberate: `useStepTurnUsage` is a hook, because
   holding a derivation at one identity needs somewhere to hold it. It sits
   here beside the pure walk it wraps rather than in the surface, so nobody
   reaches for `withStepTurnUsage` without seeing why the raw result must not
   be handed to a context. */
import * as React from "react"
import type * as acp from "@daedalus/acp"
import type { TurnGeneration } from "@daedalus/protocol"
import { couldTouchFiles } from "@/lib/tools"
import { extractEdits, type EditInputDiff } from "@/lib/tools/edits"
import { splitTurns, turnSources, type TurnSources } from "@/lib/sources"
import { turnSuggestions, type SuggestCtx, type SuggestGroup } from "@/lib/suggestions"
import type { ThreadItem } from "@/lib/store"
import { callsByStep, type ThreadCall } from "@/lib/trace"
import type { TurnChanges } from "@/lib/workspace/git-api"

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
    "what came of this turn" and must sit in the same place. The turn is always
    the WHOLE turn: what a turn cited and what it cost are read off its steps,
    whether `answersOnly` has folded them out of sight or not, and the anchor is
    the item the turn ends on — reached through a fold's tail (`rowTailId`), so
    a footer hung off a step inside one still lands. */
/* Six footers ask this of the same `items` on every streamed token; the walk
   (a Map of the thread plus `splitTurns`) is paid once per array and argument
   set, not once per footer. Keyed on the array object: the reducer hands back a
   new one on any change, so a hit is never stale. */
const FINISHED_TURNS_CACHE = new WeakMap<ThreadItem[], Map<string, { turn: ThreadItem[]; tailId: string }[]>>()

function finishedTurns(
  items: ThreadItem[],
  turnActive: boolean,
  showConfigNotices = true
): { turn: ThreadItem[]; tailId: string }[] {
  const key = `${turnActive}|${showConfigNotices}`
  let byArgs = FINISHED_TURNS_CACHE.get(items)
  if (!byArgs) FINISHED_TURNS_CACHE.set(items, (byArgs = new Map()))
  const hit = byArgs.get(key)
  if (hit) return hit
  const out = walkFinishedTurns(items, turnActive, showConfigNotices)
  byArgs.set(key, out)
  return out
}

function walkFinishedTurns(
  items: ThreadItem[],
  turnActive: boolean,
  showConfigNotices: boolean
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
  const hidden = (item: ThreadItem): boolean =>
    (item.kind === "notice" && item.config === true && !showConfigNotices) ||
    (item.kind === "error" && item.transient === true)
  const tailOf = (turn: ThreadItem[]): ThreadItem | undefined => {
    for (let i = turn.length - 1; i >= 0; i--) {
      const item = turn[i]
      /* A `!` command is not the turn's — it is the reader's own, run in the gap
         after it — so a footer never hangs off one: not when it is drawn (the
         strip would sit under the command instead of under the answer) and not
         when it is hidden (the anchor would be a row nothing draws, and the
         footer would vanish with it). */
      if (item.kind === "shell" || item.kind === "voice") continue
      if (hidden(item)) continue
      return item
    }
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

export function withTurnSources(
  items: ThreadItem[],
  turnActive: boolean,
  showConfigNotices = true
): Map<string, TurnSources> {
  const after = new Map<string, TurnSources>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
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
export function withTurnUsage(
  items: ThreadItem[],
  turnActive: boolean,
  turnUsage: Record<string, acp.Usage>,
  showConfigNotices = true
): Map<string, acp.Usage> {
  const after = new Map<string, acp.Usage>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
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
export function withTurnDuration(
  items: ThreadItem[],
  turnActive: boolean,
  turnDuration: Record<string, number>,
  showConfigNotices = true
): Map<string, number> {
  const after = new Map<string, number>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const durationMs = turnId ? turnDuration[turnId] : undefined
    if (durationMs !== undefined) after.set(tailId, durationMs)
  }
  return after
}

/** Union tool-call wall time for each finished turn, keyed by its ending row. */
export function withTurnToolDuration(
  items: ThreadItem[],
  turnActive: boolean,
  turnToolDuration: Record<string, number>,
  showConfigNotices = true
): Map<string, number> {
  const after = new Map<string, number>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const durationMs = turnId ? turnToolDuration[turnId] : undefined
    if (durationMs !== undefined) after.set(tailId, durationMs)
  }
  return after
}

/** What each finished turn's model calls wrote over their decode time, keyed
    by its ending row — the speed the footer draws. */
export function withTurnGeneration(
  items: ThreadItem[],
  turnActive: boolean,
  turnGeneration: Record<string, TurnGeneration>,
  showConfigNotices = true
): Map<string, TurnGeneration> {
  const after = new Map<string, TurnGeneration>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const generation = turnId ? turnGeneration[turnId] : undefined
    if (generation) after.set(tailId, generation)
  }
  return after
}

/**
 * Whether a turn could be the author of a diff: did it run a single tool that
 * was not a read, a search, a fetch or a thought (`couldTouchFiles`)?
 *
 * The measurement itself is git's and stays whole-worktree — that is the whole
 * point of it, since a `sed` in a shell changes the project as much as an Edit
 * call and only the worktree sees both. But git measures a *window*, not an
 * author: everything that lands between the two snapshots is attributed to
 * whichever turn was open, so a cwd shared with a second thread, an editor or
 * a build ends up handing a turn that only searched the web a chip claiming
 * seventy files. This is the one thing the transcript knows and git cannot,
 * and it is used only to decide whether to *draw* the chip.
 *
 * Subagent rows are counted, not skipped: they carry a `parentId`, but a
 * child's Edit is the parent turn's change, and the launching step is itself
 * an unclassified call so the turn qualifies either way.
 */
function turnCouldTouchFiles(turn: ThreadItem[]): boolean {
  return turn.some((item) => item.kind === "tool" && couldTouchFiles(item))
}

/** What each finished turn did to the worktree, keyed by the row it ends on
    — same walk as `withTurnUsage`, same footer slot. A turn that changed
    nothing (or was not measured), or that ran nothing that could have written
    a file, draws nothing. */
export function withTurnChanges(
  items: ThreadItem[],
  turnActive: boolean,
  turnChanges: Record<string, TurnChanges>,
  showConfigNotices = true
): Map<string, TurnChanges> {
  const after = new Map<string, TurnChanges>()
  for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
    const head = turn[0]
    const turnId = head.kind === "user" ? head.turnId : undefined
    const changes = turnId ? turnChanges[turnId] : undefined
    if (!changes || !changes.ended || changes.files.length === 0) continue
    if (!turnCouldTouchFiles(turn)) continue
    after.set(tailId, changes)
  }
  return after
}

/** One card of the inspector's turn timeline. */
export interface TimelineTurn {
  changes: TurnChanges
  /** The turn's message, when the transcript window holds it. */
  prompt?: string
  /** This thread's own edits in the turn, in order — what `editsExplain`
      replays to tell a peer's hunks from ours in a `shared` file. */
  edits: EditInputDiff[]
}

/**
 * Every measured turn worth a card, newest first — the inspector's Changes
 * timeline. The same gate as the chip (`turnCouldTouchFiles`), read per turn
 * id: a turn the loaded window holds is drawn only if it could have written;
 * one from before the window cannot be asked, so it is drawn when git says it
 * changed something (the allowlist's bargain — a card over someone else's diff
 * is a smaller lie than hiding real work). The running turn is live, drawn
 * once it has run something that could write.
 */
export function changesTimeline(
  items: ThreadItem[],
  turnChanges: Record<string, TurnChanges>
): TimelineTurn[] {
  const seen = new Map<string, { prompt: string; touches: boolean; edits: EditInputDiff[] }>()
  let current: { prompt: string; touches: boolean; edits: EditInputDiff[] } | undefined
  for (const item of items) {
    if (item.kind === "user") {
      /* A steer joins the turn it lands in; a replayed bubble has no id. */
      current = item.turnId ? (seen.get(item.turnId) ?? { prompt: item.text, touches: false, edits: [] }) : undefined
      if (item.turnId && current) seen.set(item.turnId, current)
    } else if (current && item.kind === "tool" && couldTouchFiles(item)) {
      current.touches = true
      current.edits.push(...extractEdits(item))
    }
  }
  return Object.values(turnChanges)
    .filter((changes) => {
      const turn = seen.get(changes.turnId)
      if (turn) return turn.touches && (!changes.ended || changes.unavailable || changes.files.length > 0)
      return changes.ended && changes.files.length > 0
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((changes) => {
      const turn = seen.get(changes.turnId)
      return { changes, prompt: turn?.prompt, edits: turn?.edits ?? [] }
    })
}

/** Each finished turn's suggestion card, keyed by the id of the answer that
    carries it — the same walk and the same finished-turn gating as the footers
    above: the last turn only qualifies once it has ended, so a card never
    grows under the cursor mid-answer. Only the kinds the thread has on are
    drawn (`meta.suggestKinds`) — the set is the thread's ask, and the model's
    willingness to deliver each fence is read per answer by `turnSuggestions`. */
export function withTurnSuggestions(
  items: ThreadItem[],
  turnActive: boolean,
  enabled: readonly string[],
  ctx: SuggestCtx
): Map<string, { itemId: string; groups: SuggestGroup[] }> {
  const after = new Map<string, { itemId: string; groups: SuggestGroup[] }>()
  if (enabled.length === 0) return after
  const kinds = enabled.join(",")
  for (const { turn } of finishedTurns(items, turnActive)) {
    const entry = cachedTurnSuggestions(turn, enabled, kinds, ctx)
    if (entry) after.set(entry.itemId, entry)
  }
  return after
}

/* Remembered per finished turn, as the sources are: re-parsing every answer on
   every streamed token handed each `TurnFooter` a new `groups` array, which
   is what broke its memo under every turn with suggestions. The kinds and the
   project's commands are part of the key — either changes what is drawn. */
const TURN_SUGGESTIONS_CACHE = new WeakMap<
  ThreadItem,
  {
    len: number
    last: ThreadItem
    kinds: string
    commands: SuggestCtx["definedCommands"]
    entry: ReturnType<typeof turnSuggestions>
  }
>()

function cachedTurnSuggestions(
  turn: ThreadItem[],
  enabled: readonly string[],
  kinds: string,
  ctx: SuggestCtx
): ReturnType<typeof turnSuggestions> {
  const first = turn[0]
  const last = turn[turn.length - 1]
  const hit = TURN_SUGGESTIONS_CACHE.get(first)
  if (hit && hit.len === turn.length && hit.last === last && hit.kinds === kinds && hit.commands === ctx.definedCommands)
    return hit.entry
  const entry = turnSuggestions(turn, enabled, ctx)
  TURN_SUGGESTIONS_CACHE.set(first, { len: turn.length, last, kinds, commands: ctx.definedCommands, entry })
  return entry
}

/** Every row's turn, keyed by the row's own id. A step's popover falls back to
    the billed split of the turn it sits in (`StepTokens`) only where neither
    the step's own bill (`_meta.daedalus.step`) nor a model call record joined
    to the row (`useStepCalls`) says it. The walk is the same one `withTurnUsage` does for the
    footer — the nearest user row back, which is the only thing tying a
    transcript position to a reading that arrives after it — but kept per row. */
export function withStepTurnUsage(
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

/**
 * The same map, held at one identity until its *contents* change.
 *
 * `withStepTurnUsage` walks `thread.items`, which the reducer replaces on every
 * streamed chunk, so its result is a fresh object per token even when not one
 * figure in it moved — and this map is half of the `StepTokens` context value.
 * A context whose value changes identity re-renders **every consumer**, and
 * `React.memo` does not stop it: the transcript's five memo boundaries
 * (`RowView`, `ThreadItemView`, `ToolRun`, `SubagentStep`, `ToolStep`) are all
 * bypassed, because `ThreadItemView` and `ToolStep` both call `useStepTokens`
 * unconditionally. That made the contract this codebase is built on — "a
 * streaming chunk re-renders only the changed rows instead of all n" — false
 * for the whole transcript.
 *
 * So the walk still happens per token (it is O(n) over items already in hand)
 * and only the *identity* is held. A usage figure lands on `usage_update`, so
 * past the first chunk of a step the contents are equal and the old object goes
 * back out — which is what lets the memo below it hold.
 *
 * Shallow, and that is exact rather than approximate: the values are the very
 * `acp.Usage` objects `thread.turnUsage` holds, so two runs of the walk over an
 * unchanged store put the identical references in. The same pattern, for the
 * same reason, as `useLiveTurnActive` in `lib/store/provider.tsx`.
 */
export function useStepTurnUsage(
  items: ThreadItem[],
  turnUsage: Record<string, acp.Usage>
): Record<string, acp.Usage> {
  const held = React.useRef<Record<string, acp.Usage>>({})
  return React.useMemo(() => {
    const next = withStepTurnUsage(items, turnUsage)
    const keys = Object.keys(next)
    const previous = held.current
    const same =
      keys.length === Object.keys(previous).length &&
      keys.every((key) => previous[key] === next[key])
    if (!same) held.current = next
    return held.current
  }, [items, turnUsage])
}

/** The model calls drawn on each row (`callsByStep`), held at one identity per
    entry and for the whole map until one moves — the same bargain as
    `useStepTurnUsage`, for the same reason: it is half of what every
    transcript row subscribes to. */
export function useStepCalls(
  items: ThreadItem[],
  calls: ThreadCall[]
): Record<string, { calls: ThreadCall[]; exact: boolean }> {
  const held = React.useRef<Record<string, { calls: ThreadCall[]; exact: boolean }>>({})
  return React.useMemo(() => {
    const next = callsByStep(items, calls)
    const previous = held.current
    let same = Object.keys(next).length === Object.keys(previous).length
    for (const [key, entry] of Object.entries(next)) {
      const old = previous[key]
      if (old && old.exact === entry.exact && old.calls.length === entry.calls.length && old.calls.every((c, i) => c === entry.calls[i]))
        next[key] = old
      else same = false
    }
    if (!same) held.current = next
    return held.current
  }, [items, calls])
}

/** Each finished turn's own model calls — its requests, in order — keyed by
    the row it ends on, for the turn popover's per-request list. A subagent's,
    a title's and a compaction's calls are left out: they are not this
    transcript's steps. Held at one identity per turn until one of its calls
    changes, so a record landing re-renders only its own turn's footer. */
export function useTurnCalls(
  items: ThreadItem[],
  turnActive: boolean,
  calls: ThreadCall[],
  showConfigNotices = true
): Map<string, ThreadCall[]> {
  const held = React.useRef<Map<string, ThreadCall[]>>(new Map())
  return React.useMemo(() => {
    const byTurn = new Map<string, ThreadCall[]>()
    for (const call of calls) {
      if (call.who !== "turn" || call.childId || !call.turnId) continue
      const list = byTurn.get(call.turnId)
      if (list) list.push(call)
      else byTurn.set(call.turnId, [call])
    }
    const next = new Map<string, ThreadCall[]>()
    for (const { turn, tailId } of finishedTurns(items, turnActive, showConfigNotices)) {
      const head = turn[0]
      const own = head.kind === "user" && head.turnId ? byTurn.get(head.turnId) : undefined
      if (!own) continue
      const old = held.current.get(tailId)
      next.set(tailId, old && old.length === own.length && old.every((c, i) => c === own[i]) ? old : own)
    }
    held.current = next
    return next
  }, [items, turnActive, calls, showConfigNotices])
}

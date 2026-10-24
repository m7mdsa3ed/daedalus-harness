import type * as acp from "@daedalus/acp"
import type {
  CallsVia,
  QueuedMessage,
  QuotaSnapshot,
  StagedConfig,
  ThreadRetry,
  TurnChanges,
  TurnTick,
  TpsStats,
  TurnGeneration,
  WireError,
} from "@daedalus/protocol"
import { IDLE_PHASE, isOpening, type ConnPhase } from "../thread/phase"
import type { SessionMeta } from "../settings"
import type { PendingElicitation, PendingPermission, ThreadItem } from "./items"
import type { ThreadCall } from "../trace"

export interface ThreadState {
  items: ThreadItem[]
  /**
   * What this device's connection to the thread is doing — see
   * `lib/thread/phase.ts` for the vocabulary and for what it replaces.
   *
   * Written by exactly one function (`ThreadConnection.setPhase`) through the
   * one `thread-phase` action. That is the point: the four-value `status` it
   * replaces had two writers racing for it, which is how a thread in the
   * reconnect ladder came to read `closed` — composer locked, dead-thread
   * banner up — for the whole of a recovery that was going fine.
   */
  phase: ConnPhase
  turnActive: boolean
  /** The turn is held at a step boundary (`paused` event / `caught_up`).
      Independent of `turnActive`: a paused session with no turn open holds
      its next prompt at its first step, and the toggle has to say so. */
  paused: boolean
  /** Why it is held. `"user"` is the toggle. `"error"` is a turn that **failed
      and did not end** — a rate limit, a spent quota, a key that stopped
      working — waiting at its step boundary with every tool call it already
      made intact, for a model change and a Continue. So it is drawn as an open
      turn in a stopped state, never as an `ErrorRow`: nothing failed for good,
      and re-sending the prompt would be the wrong offer. */
  pausedReason: "user" | "error" | null
  /** The failure an `"error"` hold is waiting on, in the same shape a failed
      turn carries — so the held card folds its detail through `describeError`
      exactly as `ErrorRow` does. */
  pausedError: WireError | null
  /** The turn failed on something worth trying again and is waiting out a
      backoff (`retry` event / `caught_up`). One step short of a hold and the
      same failure: if the attempts run out this clears and `pausedReason`
      becomes `"error"`. Live-only and never journaled — a retry that worked is
      not history — so it is handed over on attach like the hold and the queue,
      and null the rest of the time. */
  retry: ThreadRetry | null
  /** Background work the agent launched is still running (`background` event /
      `caught_up`). A Claude Code workflow answers its prompt `end_turn` at
      "launched" and works on for minutes, so `turnActive` is false and the
      thread is not done — this is what the transcript's own line, every list,
      and the turn-finished notification read a thread with no turn open by.
      Absolute and live-only like `retry`: handed over on attach, never
      journaled, because the run's own journaled beats are the thing that would
      keep saying `running` after the run died. */
  background: boolean
  /** Whether the runtime takes pause at all (`session_config.canPause`) —
      the harness's own agent; every other runtime has only Stop. */
  canPause: boolean
  /** Whether the runtime takes a compaction *request* (`session_config.canCompact`).
      Not whether it compacts — ACP's `compaction_update` is any agent's to send,
      and most send it without ever taking an instruction. */
  canCompact: boolean
  /** Every ask currently parked, oldest first. Parallel tool calls can block on
      more than one permission at once (the server holds a map of them), so this
      is a queue and not a slot: a second `permission` event used to overwrite
      the first card, and the ask under it became unanswerable. The head is what
      the hotkeys answer and what focus sits on; the rest stack beneath it. */
  permissions: PendingPermission[]
  elicitations: PendingElicitation[]
  /** Messages waiting for the running turn to end, in order. The server's
      list, whole — every change arrives as the `queue` event, this device's
      own included (the ids are minted there). */
  queue: QueuedMessage[]
  /** Permission-mode state (e.g. default / acceptEdits / plan) from the agent. */
  modes: acp.SessionModeState | null
  /** Agent config options (model, thinking level, …). */
  configOptions: acp.SessionConfigOption[]
  /** What the *runtime* can carry in a prompt, from the `initialize`
      handshake — the agent's half of the attachment decision (`resolveDelivery`
      in @daedalus/delivery). Null until a session has said, which is the
      ordinary state of a draft: the composer falls back to what the option
      probe learned for the (profile, agent) pair. */
  promptCapabilities: acp.PromptCapabilities | null
  /** Slash commands the agent advertises (available_commands_update). */
  availableCommands: acp.AvailableCommand[]
  /** Cumulative token usage from the last completed turn. */
  usage: acp.Usage | null
  /** What each turn cost on its own, keyed by `turnId` — the same `turn_ended`
      the running total above is folded from, kept unsummed so a turn can say
      what it spent where it sits. Keyed rather than stamped onto the user item
      because the item exists before the turn has an id (the optimistic send
      tags it later, and a replay builds it from `turn_started`) and the usage
      arrives after everything else in the turn. Journaled, so it replays. */
  turnUsage: Record<string, acp.Usage>
  /** The running turn's bill so far, summed from the per-step figures our
      runtime rides on `usage_update` (`_meta.daedalus.step`). A preview only:
      cleared at every turn boundary, where `turn_ended` folds the real total
      into `usage`. Null for a runtime that reports no step figure. */
  liveUsage: acp.Usage | null
  /** Server-measured wall clock per turn, ms, keyed by `turnId` — the same
      `turn_ended` the usage above is folded from. Kept beside it rather than
      inside it because `acp.Usage` is the SDK's shape and gains nothing by
      carrying harness timing. Journaled via the event, so it replays. */
  turnDuration: Record<string, number>
  /** Union wall time spent in the thread's own tool calls, keyed by turn. */
  turnToolDuration: Record<string, number>
  /** What each turn's model calls wrote over their decode time, keyed by
      turn — the speed's denominator, absent for a turn no call was timed in. */
  turnGeneration: Record<string, TurnGeneration>
  /** Context window occupancy from usage_update. */
  context: acp.UsageUpdate | null
  /** One record per model call (`_daedalus/model_call`), in arrival order,
      each filed under the turn that was open when it landed. Journaled, so it
      replays; the Trace panel's cold read of the route fills in the turns the
      window withheld (`lib/trace.ts`). */
  calls: ThreadCall[]
  /** Which door this process's records come through (`session_config.callsVia`).
      Null until a session has said — a draft, or a journal older than the door. */
  callsVia: CallsVia | null
  /** Persistent min/max and weighted average inputs for measured output speed. */
  tps: TpsStats | null
  /** What the model request that produced a step cost, keyed by item id — the
      per-step half of `turnUsage`, and derived rather than reported: see
      `markStepUsage`. Journaled like everything it is built from, so it
      replays. The whole reading is kept rather than just its figure: the
      step's own popover draws the window and the cost beside it, and what is
      dropped here cannot be recovered downstream. */
  stepUsage: Record<string, acp.UsageUpdate>
  /** When each step's reading arrived, keyed like `stepUsage` — the journal's
      stamp on replay, this device's clock live, the same pair a user row is
      stamped with. A step's duration is the gap to the boundary before it,
      derived in `tokensByTurn`. */
  stepAt: Record<string, number>
  /** The item the last `usage_update` was filed against — the cursor
      `markStepUsage` reads to tell one model request from the next. */
  usageMark: string | null
  /** Time to first update of the last turn, ms. */
  ttftMs: number | null
  /** What each turn did to the project's worktree, keyed by turn id — git's
      answer, not the transcript's (server turn-changes.ts). The socket's
      `turn_changes` nudges land here and `GET /api/sessions/:id/changes`
      seeds the lot on open; a thread whose project is not a repository has
      rows that say `unavailable`. */
  turnChanges: Record<string, TurnChanges>
  /** What is left of the subscription this thread's (profile, agent) pair
      spends — see lib/quota.ts. Null until a turn settles or the composer's
      stats popover asks for one: it is not part of the transcript, so nothing
      replays it and an archived thread simply has none. */
  quota: QuotaSnapshot | null
  /** No agent process behind this thread: what is on screen was served from the
      server's journal. The transcript is real and complete, but nothing can be
      sent until the thread is revived — which `actions.send` does on its own. */
  archived: boolean
  /** Steps (turns) older than the transcript, still on the server. > 0 only
      for a thread long enough to have been windowed; `actions.loadEarlier`
      fetches the next page of whole turns and re-folds. */
  earlier: number
  /** A `load_earlier` is in flight — the button says so and does not stack. */
  loadingEarlier: boolean
  /** The thread's whole table of contents from the journal — one entry per
      turn, oldest first, including the ones still withheld behind `earlier`.
      Set from `attached` (see `thread-turns`), so the turn rail draws every
      tick without paging history in. A resume carries none and leaves this
      alone; the reset on a fresh attach takes it back to empty first. */
  turns: TurnTick[]
  /**
   * A profile/model/effort change **this device** has asked for and not
   * yet had confirmed — the picks buffered before the POST goes out, and the
   * POST itself while it is in flight.
   *
   * It is an overlay on the session row rather than a patch of it, and that is
   * the whole point: the row is the server's, `refreshSessions` replaces it
   * wholesale, and a restart takes seconds during which the server's answer is
   * still the old one. Patching the row would be undone by the next list
   * refresh; overlaying it means the menu draws the value the user picked from
   * the instant they pick it, and the row underneath stays honest.
   *
   * Cleared by the server's own answer — `spawn_config`, or the `restart` that
   * ends the sequence — and by a failure, which puts the menu back.
   */
  pendingConfig: StagedConfig | null
  /** A change the *server* is holding for the next spawn (`staged_config`,
      and `caught_up` on attach). Absolute, from every peer's point of view the
      same: this device's own staging arrives back through the event like
      anyone else's. Drawn as a value the thread is about to be on, never as one
      it is on. */
  stagedConfig: StagedConfig | null
}

export interface State {
  sessions: SessionMeta[]
  /**
   * The sidebar's paging bookkeeping (`GET /api/sessions/page`).
   *
   * `sessions` above is the whole loaded list — the window the sidebar has
   * paged in, plus the rows it must keep whatever their age (trashed, pinned,
   * and the tabs this device has open) — but only `ids` are *window* rows, and
   * `ids.length` is the `offset` the next page asks from. `total` is how many
   * live threads the server holds, so "load more" knows when there is nothing
   * left to fetch.
   */
  sessionWindow: { ids: string[]; total: number }
  // Which thread is open and which screen is showing live in the URL — see lib/router.
  threads: Record<string, ThreadState>
}

/** Whether work may still be in flight for the subagent readings (rows, the
    agents count, the inspector): a turn open, or background work the server
    says outlived it — an `ask_agent` or workflow run keeps streaming its
    child's events after the turn that launched it ended. Not `turnActive`'s
    replacement: Stop, the queue and the turn footers stay the turn's. */
export const workLive = (thread: Pick<ThreadState, "turnActive" | "background">): boolean =>
  thread.turnActive || thread.background

export const emptyThread: ThreadState = {
  items: [],
  phase: IDLE_PHASE,
  turnActive: false,
  paused: false,
  pausedReason: null,
  pausedError: null,
  retry: null,
  background: false,
  canPause: false,
  canCompact: false,
  permissions: [],
  elicitations: [],
  queue: [],
  modes: null,
  configOptions: [],
  promptCapabilities: null,
  availableCommands: [],
  usage: null,
  turnUsage: {},
  liveUsage: null,
  turnDuration: {},
  turnToolDuration: {},
  turnGeneration: {},
  context: null,
  calls: [],
  callsVia: null,
  tps: null,
  stepUsage: {},
  stepAt: {},
  usageMark: null,
  ttftMs: null,
  turnChanges: {},
  quota: null,
  archived: false,
  earlier: 0,
  loadingEarlier: false,
  turns: [],
  pendingConfig: null,
  stagedConfig: null,
}

/**
 * The thread's settings as the user should see them: what the server says,
 * under what it is holding for the turn boundary, under what this device has
 * just asked for.
 *
 * One reading, in one place, because three surfaces draw it — the composer
 * chip, the settings menu's rows, and the held-turn card's copy of that menu —
 * and a chip that disagreed with the row it opens is worse than either.
 *
 * The order is the order the values become true in: `pendingConfig` is the most
 * recent statement of intent and outranks everything, a staged change is next
 * (it is going to be true at the boundary), and the row is what is true now.
 */
export function configView<T extends SessionMeta>(meta: T, thread: ThreadState): T {
  const staged = thread.stagedConfig
  const pending = thread.pendingConfig
  /* Spread, but skipping the keys whose value is `undefined`: a patch says what
     moved, and a spread of an explicit `undefined` would blank a field the
     patch never mentioned. */
  const overlay = (patch: StagedConfig | null) =>
    Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined))
  return {
    ...meta,
    ...overlay(staged),
    ...overlay(pending),
  }
}

/**
 * The agent's own selectors as the reader has left them: the live ones, under
 * what is staged for the next turn. Same layering as `configView`, for the half
 * of a thread's settings that is not on the session row — `modes` and
 * `configOptions` are the agent's to report, and a pick waiting for a turn is
 * not yet something the agent has said.
 */
export function stagedPicks(thread: ThreadState | undefined): {
  modes: ThreadState["modes"]
  configOptions: ThreadState["configOptions"]
} {
  const staged = thread?.stagedConfig
  const modes = thread?.modes ?? null
  const configOptions = thread?.configOptions ?? []
  return {
    modes:
      modes && staged?.modeId !== undefined ? { ...modes, currentModeId: staged.modeId } : modes,
    configOptions: staged?.options
      ? configOptions.map((option) =>
          option.id in staged.options!
            ? ({ ...option, currentValue: staged.options![option.id] } as acp.SessionConfigOption)
            : option
        )
      : configOptions,
  }
}

/**
 * A thread with nothing in it yet.
 *
 * Three things hang off this — the centred composer, the welcome block, and the
 * hero wash behind the whole pane — and they live in different components, so
 * they all ask here rather than each deciding for itself. A draft counts as
 * empty on sight: it has no connection to be waiting on, and nothing is ever
 * going to arrive until someone types.
 *
 * A thread that is *opening* outranks `draft`, and that ordering is the whole
 * point of the first message: the connection moves to `starting` before the
 * create POSTs, so the wash goes and the composer docks the instant the message
 * is sent rather than two seconds later when the agent has finished spawning and
 * the first item lands. The transcript is not empty at that moment in any sense
 * the user cares about — the send happened — and leaving the hero up through the
 * spawn read as the message having gone nowhere.
 */
export function threadIsEmpty(thread: ThreadState, draft?: boolean): boolean {
  if (thread.items.length > 0) return false
  // Already on its way to a transcript, draft or not: that reads as loading.
  if (isOpening(thread.phase)) return false
  if (draft) return true
  // Not yet started at all.
  return thread.phase.kind !== "idle"
}

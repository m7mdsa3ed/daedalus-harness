import { Cron } from "croner";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, routineTriggers as triggersTable } from "./db/index.js";
import {
  activeRoutineEngine,
  createRoutine,
  createTrigger,
  deleteRoutine,
  getRoutine,
  lastRunHeadOid,
  listRoutines,
  markTriggerArmed,
  markTriggerError,
  markTriggerFired,
  projectHeadOid,
  promptThread,
  recordSkippedRun,
  updateRoutine,
  type Routine,
  type RoutineEngine,
  type RoutineTrigger,
} from "./routines.js";
import type { SessionManager } from "./sessions.js";

/**
 * The clock: one sweep over `routine_triggers`, and the thin legacy surface of
 * what used to be "scheduled messages".
 *
 * A scheduled message is now a routine with `runsIn: "session"` and one schedule
 * trigger (see docs/plans/automations.md); the engine delivers the text through
 * `promptThread`, a `skipped` run says why a delivery did not happen, and
 * `scheduled_messages` is only read once, by the boot migration
 * (`scheduled-migration.ts`). `createScheduled`/`fire` keep their signatures
 * because `workflows/engine.ts` calls them; the `*Scheduled` CRUD behind
 * `/api/scheduled*` is a DEPRECATED alias over the routine model.
 *
 * Everything below the `routine triggers` banner is the clock itself: when a
 * trigger is next due, whether it was missed, and whether its condition still
 * holds. What happens after that is `RoutineEngine.fire`'s.
 */

/** The legacy wire shape of a scheduled message, derived from a routine and its
    trigger. `enabled` stays 0/1 for the old callers. DEPRECATED. */
export interface ScheduledMessage {
  /** The routine's id. */
  id: string;
  sessionId: string;
  text: string;
  nextAt: number;
  everyMs: number | null;
  enabled: number;
  skippedAt: number | null;
  lastError: string | null;
  skipCount: number;
  createdAt: number;
}

export interface ScheduledMessageInput {
  sessionId: string;
  text: string;
  /** Epoch ms of the next fire. */
  nextAt: number;
  /** Recurrence interval in ms; null = one-shot. */
  everyMs?: number | null;
  /** The harness's own notice: hidden from lists, deleted once delivered. */
  ephemeral?: boolean;
}

function scheduledView(routine: Routine, trigger: RoutineTrigger): ScheduledMessage {
  return {
    id: routine.id,
    sessionId: routine.sessionId ?? "",
    text: routine.body.kind === "prompt" ? routine.body.text : "",
    nextAt: trigger.nextFireAt ?? trigger.atMs ?? 0,
    everyMs: trigger.intervalMs,
    enabled: routine.enabled ? 1 : 0,
    skippedAt: trigger.lastError ? (trigger.lastFiredAt ?? routine.updatedAt) : null,
    lastError: trigger.lastError,
    skipCount: trigger.lastError ? 1 : 0,
    createdAt: routine.createdAt,
  };
}

/** A spent one-off (it fired, or was missed past catch-up) is disabled by the
    sweep. The old table deleted such a row, so the legacy list hides it. */
const spent = (t: RoutineTrigger) => t.atMs !== null && !t.enabled;

async function scheduleTriggerOf(routineId: string): Promise<RoutineTrigger | undefined> {
  return (await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.routineId, routineId), eq(triggersTable.kind, "schedule")))
    .orderBy(asc(triggersTable.createdAt))
    .limit(1))[0];
}

/** @deprecated Use the routines API (`runsIn: "session"`). */
export async function listScheduled(): Promise<ScheduledMessage[]> {
  const routines = (await listRoutines()).filter((r) => r.runsIn === "session");
  if (routines.length === 0) return [];
  const triggers = await db
    .select()
    .from(triggersTable)
    .where(and(inArray(triggersTable.routineId, routines.map((r) => r.id)), eq(triggersTable.kind, "schedule")))
    .orderBy(asc(triggersTable.createdAt));
  const out: ScheduledMessage[] = [];
  for (const routine of routines) {
    const trigger = triggers.find((t) => t.routineId === routine.id);
    if (trigger && !spent(trigger)) out.push(scheduledView(routine, trigger));
  }
  return out.sort((a, b) => a.nextAt - b.nextAt);
}

/** @deprecated Use the routines API (`runsIn: "session"`). Signature is relied
    on by `workflows/engine.ts`. */
export async function createScheduled(input: ScheduledMessageInput): Promise<ScheduledMessage> {
  const routine = await createRoutine({
    name: input.text.replace(/\s+/g, " ").trim().slice(0, 60) || "Scheduled message",
    runsIn: "session",
    sessionId: input.sessionId,
    body: { kind: "prompt", text: input.text },
  }, { ephemeral: input.ephemeral });
  const every = input.everyMs ?? null;
  const trigger = await createTrigger(routine.id, {
    kind: "schedule",
    atMs: every === null ? input.nextAt : null,
    intervalMs: every,
  });
  /* Armed directly with the caller's own slot: the sweep would otherwise arm a
     null clock from "now", and `nextAt` is the point of the call. */
  await markTriggerArmed(trigger.id, input.nextAt);
  return scheduledView((await getRoutine(routine.id))!, (await scheduleTriggerOf(routine.id))!);
}

export interface ScheduledPatch {
  text?: string;
  nextAt?: number;
  /** null clears the recurrence (one-shot from here on). */
  everyMs?: number | null;
  enabled?: boolean;
}

/**
 * Edit a schedule in place. Any edit also resets the trigger's error — the user
 * touching the row is the signal that whatever made it undeliverable has been
 * dealt with, so the sweep tries again (and a one-off that was spent is re-armed).
 * @deprecated Use the routines API.
 */
export async function updateScheduled(id: string, patch: ScheduledPatch): Promise<ScheduledMessage | undefined> {
  const routine = await getRoutine(id);
  const trigger = routine?.runsIn === "session" ? await scheduleTriggerOf(id) : undefined;
  if (!routine || !trigger) return undefined;
  await updateRoutine(id, {
    ...(patch.text !== undefined ? { body: { kind: "prompt" as const, text: patch.text } } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  });
  const set: Partial<RoutineTrigger> = { lastError: null, enabled: true };
  if (patch.nextAt !== undefined || patch.everyMs !== undefined) {
    const every = patch.everyMs !== undefined ? patch.everyMs : trigger.intervalMs;
    set.intervalMs = every;
    set.atMs = every ? null : (patch.nextAt ?? trigger.atMs ?? trigger.nextFireAt ?? Date.now());
    set.nextFireAt = patch.nextAt ?? null;
    set.lastFiredAt = null;
  }
  await db.update(triggersTable).set(set).where(eq(triggersTable.id, trigger.id));
  return scheduledView((await getRoutine(id))!, (await scheduleTriggerOf(id))!);
}

/** @deprecated Use the routines API. */
export async function deleteScheduled(id: string): Promise<boolean> {
  const routine = await getRoutine(id);
  if (!routine || routine.runsIn !== "session") return false;
  return await deleteRoutine(id);
}

/** Send one prompt, reviving the thread's process first if it has no live one.
    A prompt that lands mid-turn is queued behind it (see SessionManager.prompt).
    Never throws: it is the fire-and-forget door `workflows/engine.ts` uses. */
export async function fire(sessionId: string, text: string, manager: SessionManager): Promise<void> {
  const session = manager.get(sessionId);
  if (!session || session.deletedAt !== null) return;
  try {
    await promptThread(manager, sessionId, text);
  } catch (error) {
    console.error(`[scheduler] failed to deliver to ${sessionId}`, error);
  }
}

// ---------------------------------------------------------------------------
// routine triggers
// ---------------------------------------------------------------------------

/**
 * The widest a stagger may ever be, and the ceiling on the modulo below.
 *
 * Five minutes, because the failure this exists for is twenty daily routines at
 * 09:00 spawning twenty agent processes in one second on one laptop, and five
 * minutes is enough spread to make that a trickle. A *flat* five-minute offset
 * would be worse than none: it is longer than the period of anything scheduled
 * more often than every five minutes, so every fire would land past its own
 * next slot and the routine would walk itself permanently out of its schedule.
 * Hence the bound below is the smaller of this and the interval.
 */
const MAX_STAGGER_MS = 300_000;

/**
 * The floor between two fires of one trigger.
 *
 * One minute, which is the granularity of a five-field cron anyway — it is here
 * for the six-field form croner also accepts (a seconds column), where an
 * expression can name a slot every second and the sweep would hand the engine
 * fifteen fires a run. Deliberately not the one *hour* some hosted schedulers
 * impose: that is a fleet-capacity rule for somebody else's infrastructure, and
 * ours is `MAX_LIVE_ROUTINE_RUNS` plus the routine's own `overlap`.
 */
const MIN_FIRE_GAP_MS = 60_000;

/** A fire later than this behind its slot was missed, not merely late: two
    sweeps and some. Below it a trigger is on time. */
const LATE_MS = 120_000;
/** The oldest missed slot a `catchup: "once"` routine still runs for. */
const CATCHUP_WINDOW_MS = 7 * 24 * 3600_000;
/** Most missed slots counted, so a pathological expression cannot spin. */
const MISSED_COUNT_CAP = 1000;

/** How many slots the floor may walk past before the expression is treated as
    unresolvable. A `* * * * * *` behind a one-minute floor walks sixty; the
    limit is only here so a pathological pattern cannot spin the sweep. */
const SLOT_SCAN_LIMIT = 512;

/**
 * FNV-1a of a string.
 *
 * Written out rather than shared with `push.ts`'s: that one is module-private,
 * takes two arguments and returns the padded hex a Web Push `Topic` header
 * wants. Same algorithm and same reason for choosing it — this needs to be
 * stable across restarts and cheap, not unguessable. Stability is the whole
 * point: a stagger that changed on every boot would move a routine's fire time
 * every time the server restarted.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * This routine's deterministic offset into its own slot.
 *
 * Keyed on the routine and not the trigger, so a routine's two schedules land
 * at the same offset and read as one habit; bounded by the interval, so it can
 * never push a fire past the next slot (the modulo is strictly less than the
 * bound, and the bound is at most the interval).
 */
export function staggerMs(routineId: string, intervalMs: number): number {
  const bound = Math.max(1, Math.min(MAX_STAGGER_MS, Math.floor(intervalMs)));
  return fnv1a(routineId) % bound;
}

/** What a trigger's clock says next: an epoch ms, or null for a trigger that
    has no clock (`api`, `git`, a spent one-off). `error` is an expression that
    would not parse — recorded on the trigger, never thrown, since a sweep that
    threw on one bad cron would stop firing every other routine on the machine. */
export interface Slot {
  at: number | null;
  error?: string;
}

/** The columns `nextSlot` reads. A structural type so a test can pass a literal
    and so it is obvious that nothing else on the row is consulted. */
export type SlotInput = Pick<
  RoutineTrigger,
  "routineId" | "kind" | "cron" | "tz" | "atMs" | "lastFiredAt"
> & Partial<Pick<RoutineTrigger, "intervalMs" | "nextFireAt">>;

/**
 * When this trigger should next fire, stagger included.
 *
 * Always computed forward from `from` (the present), which is what makes missed
 * slots collapse to one fire: a server that was down overnight comes back, sees
 * one overdue `next_fire_at`, fires once, and asks for the next slot from now —
 * exactly the rule `deliver` already applies to a recurring message, and the
 * right one, because thirty replayed nightly reviews at 08:00 is not what
 * anybody scheduled.
 *
 * The search starts a stagger's width in the past so that a slot whose staggered
 * time has not arrived yet is not skipped when a trigger is armed mid-window;
 * `MIN_FIRE_GAP_MS` past the last fire is what stops that same slot from being
 * returned twice.
 */
export function nextSlot(trigger: SlotInput, from = Date.now()): Slot {
  if (trigger.kind !== "schedule") return { at: null };

  /* A one-off is an instant a person named, and it is deliberately NOT
     staggered: there is no interval to bound the offset by, and "run at 15:04"
     answering at 15:06 for no reason a person can see is worse than the herd
     this protects against — which one-offs, being one-offs, do not form.
     Spent once it has fired, which `last_fired_at` is what records. */
  if (trigger.atMs !== null) {
    return { at: trigger.lastFiredAt === null ? trigger.atMs : null };
  }
  /* A fixed interval, anchored on the slot it last had (`nextFireAt`) so it
     does not drift by the sweep's lateness, never staggered, and rolled past
     `from` so slots missed while off collapse to the next future one. With no
     anchor it is an interval from the last fire, else from now. */
  if (trigger.intervalMs != null) {
    const every = Math.max(MIN_FIRE_GAP_MS, trigger.intervalMs);
    let at = trigger.nextFireAt ?? (trigger.lastFiredAt ?? from) + every;
    if (at <= from) at += Math.ceil((from - at + 1) / every) * every;
    return { at };
  }
  if (!trigger.cron) return { at: null };

  try {
    const cron = new Cron(trigger.cron, trigger.tz ? { timezone: trigger.tz } : {});
    const start = new Date(from - MAX_STAGGER_MS);
    /* Two runs, for the interval the stagger is bounded by. One run means an
       expression with no future beyond it (a dated cron); the cap stands in,
       and the loop below returns that single slot or nothing. */
    const first = cron.nextRuns(2, start);
    if (first.length === 0) return { at: null };
    const interval = first.length === 2 ? first[1]!.getTime() - first[0]!.getTime() : MAX_STAGGER_MS;
    const stagger = staggerMs(trigger.routineId, interval);
    const floor = Math.max(from, (trigger.lastFiredAt ?? 0) + MIN_FIRE_GAP_MS);

    let slot: Date | null = first[0]!;
    for (let i = 0; slot && i < SLOT_SCAN_LIMIT; i++) {
      const at = slot.getTime() + stagger;
      if (at > floor) return { at };
      slot = cron.nextRun(slot);
    }
    return { at: null, error: `no slot for "${trigger.cron}" within ${SLOT_SCAN_LIMIT} runs` };
  } catch (error) {
    /* An unparseable expression AND an invalid timezone both land here — croner
       accepts a bad zone at construction and throws when it first has to
       convert a date, so this catch has to wrap the evaluation and not just the
       parse. Either way the trigger keeps a null clock, which is inert, and the
       reason is on the row for the form to print. */
    return { at: null, error: describe(error) };
  }
}

/** True while a sweep is in flight. It reads git and awaits the engine, so a
    slow project must not let the next tick start a second pass over the same
    due rows. */
let routineSweepRunning = false;

/**
 * Every schedule trigger, in one pass: arm the ones with no clock, fire the
 * ones whose clock has come.
 *
 * Ordered by `next_fire_at` — nulls first in SQLite, so arming happens before
 * firing and a trigger armed into the past waits one tick (fifteen seconds)
 * rather than being armed and fired inside one iteration, where the row read
 * and the row written would be two different states of the same trigger.
 */
async function sweepRoutines(): Promise<void> {
  const engine = activeRoutineEngine();
  /* No engine means this process never built one. Not an error, and nothing to
     say about it every fifteen seconds. */
  if (!engine) return;

  const triggers = await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.kind, "schedule"), eq(triggersTable.enabled, true)))
    .orderBy(asc(triggersTable.nextFireAt), asc(triggersTable.createdAt));

  const now = Date.now();
  for (const trigger of triggers) {
    if (trigger.nextFireAt === null) {
      arm(trigger, now);
      continue;
    }
    if (trigger.nextFireAt > now) continue;
    await fireTrigger(engine, trigger, now);
  }
}

/**
 * Resolve a trigger's expression into a clock.
 *
 * `createTrigger`/`updateTrigger` leave `next_fire_at` null on purpose — that
 * file does not know what "next" means for a cron expression, and a stale slot
 * would fire the old schedule once more before correcting itself. This is where
 * that null is answered, which is also why a user fixing a bad expression heals
 * on the next tick with no further action.
 */
async function arm(trigger: RoutineTrigger, now: number): Promise<void> {
  const slot = nextSlot(trigger, now);
  if (slot.error) {
    /* Written only when it changed. The same trigger is re-evaluated every
       fifteen seconds and the same message would otherwise be an UPDATE a
       thousand times an hour saying nothing new. */
    if (trigger.lastError !== slot.error) await markTriggerError(trigger.id, slot.error);
    return;
  }
  /* A null with no error is a trigger that legitimately has no clock — a
     one-off that has already fired. Leave it exactly as it is; writing would
     only clear a `last_error` nothing set. */
  if (slot.at === null) return;
  await markTriggerArmed(trigger.id, slot.at);
}

/** One due trigger: roll its clock forward, then decide whether anything runs. */
async function fireTrigger(engine: RoutineEngine, trigger: RoutineTrigger, now: number): Promise<void> {
  const routine = await getRoutine(trigger.routineId);
  /* The row cascades with its routine, so this is the deleted-mid-sweep window
     and nothing more. Stop the clock rather than re-reading it every tick. */
  if (!routine) {
    await markTriggerArmed(trigger.id, null);
    return;
  }

  /* Rolled forward BEFORE anything is fired, exactly as `deliver` does it, so a
     slow git read or a slow spawn cannot delay the recurrence. `lastFiredAt` is
     overridden to now so the one-minute floor is measured from this fire and
     not the last one — the row itself is not stamped until the outcome is
     known, because a fire that did not happen must not read as one that did. */
  const next = nextSlot({ ...trigger, lastFiredAt: now }, now);

  /* A disabled routine keeps its schedule and runs nothing. Deliberately not a
     `skipped` run: the engine writes one of those for a routine disabled
     between the fire and the run, which is an event, where this is a state —
     and a nightly routine somebody switched off in March should not have
     written two hundred rows saying so by September. */
  if (!routine.enabled) {
    await markTriggerArmed(trigger.id, next.at);
    return;
  }

  /* A slot missed (the server was off, asleep, or stuck) rather than merely
     late. `catchup: "once"` runs the latest one if it is within a week and
     logs the older ones as one skipped "missed" row; `none`, or anything older
     than the window, only logs. Always visible, never silent. */
  if (trigger.nextFireAt !== null && now - trigger.nextFireAt > LATE_MS) {
    const missed = missedSlots(trigger, now);
    const runIt = routine.catchup === "once" && now - trigger.nextFireAt <= CATCHUP_WINDOW_MS;
    const older = runIt ? missed - 1 : missed;
    if (older > 0) {
      await recordSkippedRun(routine.id, {
        source: "schedule",
        triggerId: trigger.id,
        code: "missed",
        reason: `${older} scheduled run(s) were missed while the server was not running${runIt ? "" : routine.catchup === "none" ? " (catch-up is off)" : " (older than 7 days)"}`,
      });
    }
    if (!runIt) {
      await markTriggerArmed(trigger.id, next.at);
      if (trigger.atMs !== null) {
        if (routine.ephemeral) await deleteRoutine(routine.id);
        else await db.update(triggersTable).set({ enabled: false }).where(eq(triggersTable.id, trigger.id));
      }
      return;
    }
  }

  /* Conditions are checked at FIRE time and never at edit time: what they ask
     about is the world, and the world moves between the two. */
  let headOid: string | null = null;
  if (trigger.condition?.gitChangedSince === "lastRun") {
    headOid = await projectHeadOid(routine.projectId);
    const seen = await lastRunHeadOid(routine.id);
    /* Both halves have to be known. A null on either side is the first run
       against this project, or a directory that is not a repository — neither
       of which can say "nothing changed", so the fire goes ahead. */
    if (headOid !== null && seen !== null && headOid === seen) {
      await recordSkippedRun(routine.id, {
        source: "schedule",
        triggerId: trigger.id,
        code: "unchanged",
        reason: "nothing has changed in the project since the last run",
        headOid,
      });
      /* The clock advances normally. A skip is not an error and not a backoff:
         the trigger is due again at its next ordinary slot, and the run list
         says in words why last night produced nothing. */
      await markTriggerArmed(trigger.id, next.at, headOid);
      return;
    }
  }

  try {
    /* Not through `authorizeFire`: the rate limit there is about the shape of
       traffic at an unauthenticated door, and a clock this process owns cannot
       hammer itself — putting the sweep behind it would silently drop scheduled
       work the moment a routine had several triggers. `fire` answers as soon as
       the run row exists, so a thirty-minute review does not hold the loop. */
    const view = await engine.fire(routine.id, { source: "schedule", triggerId: trigger.id, headOid });
    /* A delivery into a thread that is gone is the trigger's error too, which
       is where the legacy list (and a form) reads "why is this stuck". */
    if (view.status === "skipped" && view.skipReason?.startsWith("thread-")) {
      await markTriggerError(trigger.id, view.error, next.at);
    } else {
      await markTriggerFired(trigger.id, now, next.at, headOid);
    }
  } catch (error) {
    /* `fire` only throws for an unknown routine; everything it decides is a
       `skipped` row. Recorded on the trigger with the clock still rolled
       forward, so one bad night does not stop the schedule. */
    await markTriggerError(trigger.id, describe(error), next.at);
  }
  /* A one-off is spent by firing: disabled, so it reads "ran" and cannot be
     re-armed from its still-valid `at_ms`. */
  if (trigger.atMs !== null) {
    if (routine.ephemeral) await deleteRoutine(routine.id);
    else await db.update(triggersTable).set({ enabled: false }).where(eq(triggersTable.id, trigger.id));
  }
}

/** How many slots a trigger has had due since `nextFireAt` (itself included),
    for the "N missed" row. Stagger is ignored: it shifts the count by at most
    the edge slot. */
function missedSlots(trigger: RoutineTrigger, now: number): number {
  const first = trigger.nextFireAt!;
  if (trigger.atMs !== null) return 1;
  if (trigger.intervalMs != null) {
    return Math.min(MISSED_COUNT_CAP, 1 + Math.floor((now - first) / Math.max(MIN_FIRE_GAP_MS, trigger.intervalMs)));
  }
  if (!trigger.cron) return 1;
  try {
    const cron = new Cron(trigger.cron, trigger.tz ? { timezone: trigger.tz } : {});
    let count = 1;
    for (let slot = cron.nextRun(new Date(first)); slot && slot.getTime() <= now && count < MISSED_COUNT_CAP; slot = cron.nextRun(slot)) count += 1;
    return count;
  } catch {
    return 1;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------

const SWEEP_MS = 15_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** One pass of the sweep, awaited. Tests drive the clock with this; the timer
    below is the only other caller. */
export async function sweepNow(): Promise<void> {
  await sweepRoutines();
}

/** Start the sweep. Idempotent; one loop for the whole process. The manager is
    unused (the engine holds it); the parameter stays so `index.ts` is unchanged. */
export function startScheduler(_manager?: SessionManager): void {
  if (timer) return;
  const sweep = () => {
    if (routineSweepRunning) return;
    routineSweepRunning = true;
    void sweepRoutines()
      .catch((error) => console.error("[scheduler] sweep failed", error))
      .finally(() => {
        routineSweepRunning = false;
      });
  };
  /* Run once on boot: triggers that came due while the server was down are
     caught up (or logged as missed) now, and every trigger left with a null
     clock by a CRUD write is armed. index.ts calls this AFTER
     `RoutineEngine.recoverAtBoot()`, which is what makes the first sweep safe. */
  sweep();
  timer = setInterval(sweep, SWEEP_MS).unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

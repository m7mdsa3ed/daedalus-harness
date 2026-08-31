import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { and, asc, eq, lt, lte } from "drizzle-orm";
import { db, routineTriggers as triggersTable, scheduledMessages as scheduledTable } from "./db/index.js";
import { getProfile } from "./profiles.js";
import { getProject } from "./projects.js";
import {
  activeRoutineEngine,
  getRoutine,
  lastRunHeadOid,
  markTriggerArmed,
  markTriggerError,
  markTriggerFired,
  projectHeadOid,
  recordSkippedRun,
  type RoutineEngine,
  type RoutineTrigger,
} from "./routines.js";
import type { SessionManager } from "./sessions.js";

/**
 * A scheduled message: the server delivers `text` to a thread's agent at
 * `nextAt`, and — for a recurring row — again every `everyMs` until cancelled.
 *
 * Delivery is the SERVER's job, not a browser tab's. The PWA's whole bargain is
 * "the server is the ACP client", and a scheduled turn has to happen when
 * nobody is looking; the sweep below is the same periodic-loop shape as the
 * idle-retirement one in SessionManager, and it fires even while every client
 * is closed (the thread's peers just get the resulting `turn_started`/`update`
 * events, exactly the way a push would).
 *
 * The same loop also fires **routine schedule triggers** (`routines.ts`), and
 * that is one loop on purpose rather than two intervals: a routine and a
 * scheduled message that came due in the same second then have an ordering
 * instead of a race for the machine. The two are not otherwise folded together
 * and must not be — a scheduled message delivers text into ONE existing thread
 * over and over, a routine has no thread at all and mints a fresh one per fire.
 * Everything below the `routine triggers` banner is the trigger half: when a
 * trigger is next due, and whether its condition still holds when it is. What
 * happens after that is `RoutineEngine.fire`'s, and nothing here knows anything
 * about it.
 */

export type ScheduledMessage = typeof scheduledTable.$inferSelect;

export interface ScheduledMessageInput {
  sessionId: string;
  text: string;
  /** Epoch ms of the next fire. */
  nextAt: number;
  /** Recurrence interval in ms; null = one-shot. */
  everyMs?: number | null;
}

export function listScheduled(): ScheduledMessage[] {
  return db.select().from(scheduledTable).orderBy(asc(scheduledTable.nextAt)).all();
}

export function createScheduled(input: ScheduledMessageInput): ScheduledMessage {
  const row: ScheduledMessage = {
    id: randomUUID(),
    sessionId: input.sessionId,
    text: input.text,
    nextAt: input.nextAt,
    everyMs: input.everyMs ?? null,
    enabled: 1,
    skippedAt: null,
    lastError: null,
    skipCount: 0,
    createdAt: Date.now(),
  };
  db.insert(scheduledTable).values(row).run();
  return row;
}

export interface ScheduledPatch {
  text?: string;
  nextAt?: number;
  /** null clears the recurrence (one-shot from here on). */
  everyMs?: number | null;
  enabled?: boolean;
}

/**
 * Edit a schedule in place. Any edit also resets the skip state — the user
 * touching the row is the signal that whatever made it undeliverable (a
 * trashed thread, a typo'd time) has been dealt with, so the sweep tries again.
 */
export function updateScheduled(id: string, patch: ScheduledPatch): ScheduledMessage | undefined {
  const set: Partial<ScheduledMessage> = { skippedAt: null, lastError: null, skipCount: 0 };
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.nextAt !== undefined) set.nextAt = patch.nextAt;
  if (patch.everyMs !== undefined) set.everyMs = patch.everyMs;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  const changed = db.update(scheduledTable).set(set).where(eq(scheduledTable.id, id)).run().changes;
  if (changed === 0) return undefined;
  return db.select().from(scheduledTable).where(eq(scheduledTable.id, id)).get();
}

export function deleteScheduled(id: string): boolean {
  return db.delete(scheduledTable).where(eq(scheduledTable.id, id)).run().changes > 0;
}

/**
 * One due row. Consume a one-shot, or roll a recurring one forward to its next
 * future slot — and only then try to deliver it. Rolling forward before firing
 * keeps a slow respawn from delaying the recurrence, and skipping the overdue
 * slots means a server that was down overnight fires a daily schedule once on
 * boot rather than replaying every missed interval.
 *
 * A trashed or vanished thread does NOT get scheduled turns: the row is left
 * where it is (not advanced, not consumed) so the user can fix the thread or
 * cancel the schedule, rather than the server silently firing forever at a
 * thread nobody can see. Each such sweep stamps `skippedAt`/`lastError` and
 * counts the skip; past MAX_SCHEDULE_SKIPS the sweep stops selecting the row
 * (it stays listable, and any PATCH resets the count) instead of re-matching
 * it every 15 seconds forever.
 */
export const MAX_SCHEDULE_SKIPS = 20;

function deliver(row: ScheduledMessage, manager: SessionManager): void {
  const session = manager.get(row.sessionId);
  if (!session || session.deletedAt !== null) {
    db.update(scheduledTable)
      .set({
        skippedAt: Date.now(),
        lastError: session ? "the thread is in the trash" : "the thread no longer exists",
        skipCount: row.skipCount + 1,
      })
      .where(eq(scheduledTable.id, row.id))
      .run();
    return;
  }

  if (row.everyMs !== null) {
    let nextAt = row.nextAt + row.everyMs;
    while (nextAt <= Date.now()) nextAt += row.everyMs;
    db.update(scheduledTable)
      .set({ nextAt, skippedAt: null, lastError: null, skipCount: 0 })
      .where(eq(scheduledTable.id, row.id))
      .run();
  } else {
    db.delete(scheduledTable).where(eq(scheduledTable.id, row.id)).run();
  }

  void fire(row.sessionId, row.text, manager);
}

/** Send one prompt, reviving the thread's process first if it has no live one.
    A prompt that lands mid-turn is queued behind it (see SessionManager.prompt). */
async function fire(sessionId: string, text: string, manager: SessionManager): Promise<void> {
  const session = manager.get(sessionId);
  if (!session || session.deletedAt !== null) return;
  try {
    if (session.bridge && !session.exited) {
      // A live bridge may still be booting (acpSessionId unset until session/new
      // answers). `ready` is the handshake's own promise; awaiting it is cheap
      // when it has already resolved. It never rejects as unhandled — start()
      // attached a catch handler when the bridge was created.
      await session.bridge.ready;
      await manager.prompt(sessionId, text);
      return;
    }
    // Idle-retired or pre-restart: revive the way the client's "open a closed
    // thread" does — respawn + session/load — then send.
    const profile = getProfile(session.profileId);
    const project = getProject(session.projectId);
    if (!profile || !project) return;
    await manager.respawn(sessionId, profile, session.agentId, project, session.model, session.effort);
    const revived = manager.get(sessionId);
    if (revived?.bridge && !revived.exited) {
      await revived.bridge.ready;
      await manager.prompt(sessionId, text);
    }
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
>;

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

/** True while a routine sweep is in flight. The scheduled-message half is
    synchronous and cannot overlap; this half reads git and awaits the engine,
    so a slow project must not let the next tick start a second pass over the
    same due rows. */
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
  /* No engine means this process never built one (a test that only wants the
     message half). Not an error, and nothing to say about it every fifteen
     seconds. */
  if (!engine) return;

  const triggers = db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.kind, "schedule"), eq(triggersTable.enabled, true)))
    .orderBy(asc(triggersTable.nextFireAt), asc(triggersTable.createdAt))
    .all();

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
function arm(trigger: RoutineTrigger, now: number): void {
  const slot = nextSlot(trigger, now);
  if (slot.error) {
    /* Written only when it changed. The same trigger is re-evaluated every
       fifteen seconds and the same message would otherwise be an UPDATE a
       thousand times an hour saying nothing new. */
    if (trigger.lastError !== slot.error) markTriggerError(trigger.id, slot.error);
    return;
  }
  /* A null with no error is a trigger that legitimately has no clock — a
     one-off that has already fired. Leave it exactly as it is; writing would
     only clear a `last_error` nothing set. */
  if (slot.at === null) return;
  markTriggerArmed(trigger.id, slot.at);
}

/** One due trigger: roll its clock forward, then decide whether anything runs. */
async function fireTrigger(engine: RoutineEngine, trigger: RoutineTrigger, now: number): Promise<void> {
  const routine = getRoutine(trigger.routineId);
  /* The row cascades with its routine, so this is the deleted-mid-sweep window
     and nothing more. Stop the clock rather than re-reading it every tick. */
  if (!routine) {
    markTriggerArmed(trigger.id, null);
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
    markTriggerArmed(trigger.id, next.at);
    return;
  }

  /* Conditions are checked at FIRE time and never at edit time: what they ask
     about is the world, and the world moves between the two. */
  let headOid: string | null = null;
  if (trigger.condition?.gitChangedSince === "lastRun") {
    headOid = await projectHeadOid(routine.projectId);
    const seen = lastRunHeadOid(routine.id);
    /* Both halves have to be known. A null on either side is the first run
       against this project, or a directory that is not a repository — neither
       of which can say "nothing changed", so the fire goes ahead. */
    if (headOid !== null && seen !== null && headOid === seen) {
      recordSkippedRun(routine.id, {
        source: "schedule",
        triggerId: trigger.id,
        reason: "nothing has changed in the project since the last run",
        headOid,
      });
      /* The clock advances normally. A skip is not an error and not a backoff:
         the trigger is due again at its next ordinary slot, and the run list
         says in words why last night produced nothing. */
      markTriggerArmed(trigger.id, next.at, headOid);
      return;
    }
  }

  try {
    /* Not through `authorizeFire`: the rate limit there is about the shape of
       traffic at an unauthenticated door, and a clock this process owns cannot
       hammer itself — putting the sweep behind it would silently drop scheduled
       work the moment a routine had several triggers. `fire` answers as soon as
       the run row exists, so a thirty-minute review does not hold the loop. */
    await engine.fire(routine.id, { source: "schedule", triggerId: trigger.id, headOid });
    markTriggerFired(trigger.id, now, next.at, headOid);
  } catch (error) {
    /* `fire` only throws for an unknown routine; everything it decides is a
       `skipped` row. Recorded on the trigger with the clock still rolled
       forward, so one bad night does not stop the schedule. */
    markTriggerError(trigger.id, describe(error), next.at);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------

const SWEEP_MS = 15_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Start the delivery sweep. Idempotent; one loop for the whole process. */
export function startScheduler(manager: SessionManager): void {
  if (timer) return;
  const sweep = () => {
    try {
      const due = db
        .select()
        .from(scheduledTable)
        .where(and(
          lte(scheduledTable.nextAt, Date.now()),
          eq(scheduledTable.enabled, 1),
          lt(scheduledTable.skipCount, MAX_SCHEDULE_SKIPS),
        ))
        .orderBy(asc(scheduledTable.nextAt))
        .all();
      for (const row of due) deliver(row, manager);
    } catch (error) {
      console.error("[scheduler] sweep failed", error);
    }
    /* The routine half, after the message half and never interleaved with it,
       so the ordering of two things due in the same second is a decision rather
       than a race. Not awaited — the loop is a timer, not a queue — but guarded
       against overlapping itself. */
    if (!routineSweepRunning) {
      routineSweepRunning = true;
      void sweepRoutines()
        .catch((error) => console.error("[scheduler] routine sweep failed", error))
        .finally(() => {
          routineSweepRunning = false;
        });
    }
  };
  /* Run once on boot: schedules that came due while the server was down fire
     now, and every trigger left with a null clock by a CRUD write (or by a
     restart mid-edit) is armed. index.ts calls this AFTER
     `RoutineEngine.recoverAtBoot()`, which is what makes the first sweep safe —
     the runs that process left behind are already closed by the time a trigger
     here can start another. */
  sweep();
  timer = setInterval(sweep, SWEEP_MS).unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

import { asc, eq, inArray } from "drizzle-orm";
import { ASK_EVERYTHING } from "./autonomy.js";
import { appSettings, db, routineTriggers, routines, scheduledMessages, sessions } from "./db/index.js";

/**
 * Scheduled messages are `runsIn: "session"` routines now (docs/plans/automations.md).
 * Once, at boot, every `scheduled_messages` row becomes a routine with one
 * schedule trigger and a marker is left. The table stays declared (a table push
 * does not know about is a table push drops) and is never read again.
 *
 * A row keeps its id as the routine's id, so the pass is idempotent even without
 * the marker, and the legacy `/api/scheduled/:id` ids keep resolving. The skip
 * state (`last_error`) lands on the trigger; a row the old sweep had parked
 * (`skip_count` past MAX_SCHEDULE_SKIPS) comes over disabled.
 */
const DONE_KEY = "scheduledToRoutines";
const LEGACY_MAX_SKIPS = 20;

export interface LegacyScheduled {
  id: string;
  sessionId: string;
  text: string;
  nextAt: number;
  everyMs?: number | null;
  enabled?: number | null;
  lastError?: string | null;
  skipCount?: number | null;
  createdAt: number;
}

export interface ThreadOwner {
  projectId: string;
  profileId: string;
  agentId: string;
}

/** The routine + trigger rows for one legacy row. Pure, so a backup import can
    use it for an old bundle's `scheduled` key. `owner` is the thread's own
    project/profile/agent (blank when the thread is unknown). */
export function routineFromScheduled(row: LegacyScheduled, owner: ThreadOwner | undefined, now = Date.now()) {
  const every = row.everyMs ?? null;
  const routine: typeof routines.$inferInsert = {
    id: row.id,
    name: row.text.replace(/\s+/g, " ").trim().slice(0, 60) || "Scheduled message",
    description: null,
    enabled: (row.enabled ?? 1) === 1 && (row.skipCount ?? 0) < LEGACY_MAX_SKIPS,
    projectId: owner?.projectId ?? "",
    profileId: owner?.profileId ?? "",
    agentId: owner?.agentId ?? "",
    model: "",
    effort: "",
    configChoices: {},
    body: { kind: "prompt", text: row.text },
    output: null,
    onFinish: [],
    overlap: "skip",
    autonomy: ASK_EVERYTHING,
    dryRunCompleted: true,
    runsIn: "session",
    sessionId: row.sessionId,
    catchup: "once",
    worktree: false,
    createdAt: row.createdAt || now,
    updatedAt: now,
  };
  const trigger: typeof routineTriggers.$inferInsert = {
    id: `${row.id}-schedule`,
    routineId: row.id,
    kind: "schedule",
    enabled: true,
    cron: null,
    tz: null,
    atMs: every === null ? row.nextAt : null,
    intervalMs: every,
    condition: null,
    nextFireAt: row.nextAt,
    secretHash: null,
    secretCreatedAt: null,
    branch: null,
    paths: [],
    debounceMs: 30_000,
    lastSeen: null,
    lastFiredAt: null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt || now,
  };
  return { routine, trigger };
}

export async function migrateScheduledMessages(): Promise<number> {
  const done = (await db.select().from(appSettings).where(eq(appSettings.key, DONE_KEY)).limit(1))[0];
  if (done) return 0;
  const rows = await db.select().from(scheduledMessages).orderBy(asc(scheduledMessages.nextAt));
  let migrated = 0;
  if (rows.length > 0) {
    const have = new Set(
      (await db.select({ id: routines.id }).from(routines).where(inArray(routines.id, rows.map((r) => r.id)))).map((r) => r.id),
    );
    const owners = new Map(
      (await db
        .select({ id: sessions.id, projectId: sessions.projectId, profileId: sessions.profileId, agentId: sessions.agentId })
        .from(sessions)
        .where(inArray(sessions.id, rows.map((r) => r.sessionId)))).map((o) => [o.id, o]),
    );
    await db.transaction(async (tx) => {
      for (const row of rows) {
        if (have.has(row.id)) continue;
        const made = routineFromScheduled(row, owners.get(row.sessionId));
        await tx.insert(routines).values(made.routine);
        await tx.insert(routineTriggers).values(made.trigger);
        migrated += 1;
      }
    });
  }
  await db.insert(appSettings).values({ key: DONE_KEY, value: "1" }).onConflictDoNothing();
  return migrated;
}

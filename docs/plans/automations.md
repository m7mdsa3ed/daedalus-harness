# Automations: routines + scheduled messages, rebuilt as one thing

Status: plan, nothing built. Replaces `routines` and `scheduled_messages`.
References: Codex "Scheduled tasks / Automations" and Claude Code Desktop "Routines / scheduled tasks / `/loop`".

## Why rebuild

Today there are two modules that share a 15s sweep and nothing else (`scheduler.ts:25-41`).
A scheduled message pushes text into one existing thread; a routine mints a new thread per fire.
Codex and Claude both treat these as the **same object with a "runs in" choice**, so the user sees one list, one form, one history.
Ours has two sidebar rows, two page sets, two query files, two vocabularies (`enabled` is 0/1 in one, boolean in the other) and a cross-import (`schedule-page` -> `routines/trigger-summary`).

## The model (one noun)

**Automation** = prompt + where it runs + when it fires + what it may do + what happens after.

| Part | Values | Notes |
| --- | --- | --- |
| Runs in | `new thread` (default) / `this thread` | Codex standalone vs thread automation; Claude routine vs `/loop`. `this thread` pins a `sessionId` (FK cascade, as `scheduled_messages` has now). |
| Body | `prompt` / `workflow` | workflow body is kept as is. `message` is just `prompt` + `this thread`. |
| Where | project (+ worktree toggle) | worktree infra already exists (`threadCwd`); expose it per automation. Not for `this thread`. |
| Who | profile, agent, model, effort, configChoices | unchanged from routines. Derived from the thread for `this thread`. |
| Triggers | N of: `schedule`, `api`, `git`, `manual` | combinable on one automation, like Claude. `manual` = a saved prompt with Run now. |
| Access | autonomy policy (existing `AutonomyPolicy`) | per-automation, with an "Always allowed" panel (Claude) and a full-access warning. |
| After | `onFinish` actions (push, task, knowledge, chain) | existing, kept. |
| Overlap | `skip` / `queue` | existing. For `this thread` only `skip` (a busy thread queues via `fire`). |
| Catch-up | `once` (default) / `none` | NEW. On boot/wake run once for the latest missed slot within 7 days, log older ones as skipped "missed". |

A **run** is a normal thread (or a delivery into one), linked back. Status: `running | completed | failed | blocked | skipped | needs-you`.
`skipped` always carries a reason (previous still running, thread trashed, missed, disabled, quota floor, no changes, rate limit).

## Schedule trigger

- Presets: **Manual, Every N min/hours, Hourly, Daily, Weekdays, Weekly (day picker), Monthly, Once**, then **Custom (cron + tz)**. Presets compile to cron; the form always shows the resulting sentence ("Weekdays at 09:07 Cairo time") and the next 3 fire times.
- Keep the deterministic stagger (`staggerMs`) and nudge a user-picked on-the-hour time to :07 with a one-line hint (Claude does this).
- `Once` auto-disables after firing and reads "Ran".
- Minimum interval 1 minute (existing `MIN_FIRE_GAP_MS`).
- `this thread` interval schedules are the old "scheduled message" (every N minutes, one-shot): they fall out of the same trigger, no special case.

## Other triggers

- **API**: keep `/rt/:key/:routineId/fire`, token shown once, rotate/delete, optional `text` payload. Public URL and stored tokens must NOT change (external webhooks). Rename only in the UI.
- **Git**: keep `RoutineGitTriggers` (HEAD change, branch, paths, debounce). It already is the "on commit" event source.
- **Later, not this pass**: GitHub PR/release events (Claude cloud). Needs an app/webhook receiver; the trigger table's `kind` column leaves room.

## Inbox (the Codex idea that changes the feel)

Runs that **produced findings, failed, or are waiting on a permission** appear in an **Inbox** with an unread badge; quiet runs auto-archive.
Reuse the existing `/api/pending` + notifications "needs you" page rather than a new surface: add a `run` row kind. "Quiet" = the run's structured `output`/`verdict` says nothing to report (the routine already has an `output` schema + `verdict`); runs with no schema are never auto-archived.

## UX

One sidebar row **Automations** (count of enabled). One route set `/automations`, `/automations/new`, `/automations/:id`, `/automations/:id/runs/:runId`. All built from the page kit in CLAUDE.md (`TabBar`, `DataTable`, `StatusBadge`, `FormShell`, `Segmented`, `ChoiceTiles`); no new card/tab/rail.

1. **List** (`DataTable`): name, runs-in chip (thread icon / project), trigger summary ("Weekdays 09:07"), next run, last result badge, enabled toggle; row action Run now. Group/filter: Active, Paused, Needs you; filter by project. Header action: **New automation**.
2. **New** opens a **template gallery first** (`ChoiceTiles`), then the form prefilled. "Blank" is one tile. Also a conversational path: the composer's `/automate` (replaces `/schedule`) drafts the prompt + schedule from chat and opens the form to review, never saves silently.
3. **Form** (`FormShell` anchors): Name & prompt (with "make it self-contained, say what success looks like" hint) -> Runs in (`Segmented`: New thread / This thread) -> When (preset picker + next-fire preview) -> Where (project, worktree toggle) -> Agent (profile/model/effort) -> Access (autonomy tiles + warning) -> After (onFinish). Advanced folds hold overlap, catch-up, API token, git trigger.
4. **Detail** tabs: **Overview** (Run now, Pause/Resume, next run, config summary), **Runs** (history incl. skipped with reason), **Triggers**, **Access** (Always allowed list, revocable), **Settings**. Delete asks "also archive its threads?".
5. **Test first**: "Run now" on a fresh automation is a dry run (existing `dry_run_completed` gate stays: blanket allow requires one completed dry run).
6. A thread's footer gets an **Automations** reading (like Todo/Agents): count of automations pinned to this thread, click to manage. Replaces the `/schedule` deep link.

### Template catalogue (gallery)

Daily repo brief (24h commits by workstream); PR review (on open, git/API); Dependency audit (weekly); CI failure triage; Release notes / changelog draft; Docs drift check (weekly); Issue/backlog triage; Deploy verification (API-triggered go/no-go); Alert triage (API payload -> fix attempt); Bug-fix my recent commits; Morning briefing; **This thread**: Babysit this PR, Poll until green, Remind me / follow up in N hours.

## Data / migration

Per CLAUDE.md: edit `server/src/db/schema.ts`, `pnpm db:push`, **no backup is taken by push, back up first**. Anything not declared is dropped, so the old tables stay declared until the migration has run everywhere (same bargain as `personas`).

- Keep tables `routines`, `routine_triggers`, `routine_runs`, link tables; they ARE the automation model. Renaming tables buys nothing and breaks backup bundles. Rename in the UI/API surface only.
- Add to `routines`: `runsIn` (`thread|session`), `sessionId` (nullable, FK cascade to sessions for `session`), `catchup` (`once|none`), `worktree` (bool). Make `projectId/profileId/agentId` nullable only for `session` mode (derived).
- Add `routine_triggers.kind = "manual"`; add `skipReason` (text) on `routine_runs`; add `inboxState` (`unread|read|archived`) on `routine_runs`.
- One-time boot migration (marker, like `savedPromptsToCommands`): each `scheduled_messages` row -> a `session`-mode routine with one schedule trigger (`everyMs` -> interval cron or a fixed-interval field, `nextAt` -> `nextFireAt`, `skip*` -> trigger `lastError` + a skipped run). `scheduled_messages` stays declared, no longer read.
- `everyMs` has no clean cron form for odd intervals: add `intervalMs` on the trigger beside `cron` rather than lossy conversion.
- Backup bundle: add the new columns, and still READ the old `scheduled` key on restore (old bundles exist); map it through the same migration.

## Server work

1. Fold `fire`/`createScheduled` semantics into the engine as `runsIn=session` delivery. **Keep the `scheduler.ts` exports `createScheduled` and `fire` with identical signatures** as thin wrappers: `workflows.ts:37,871,1202-1203` depends on them (boot failure notice, shutdown notice, "queue behind a running turn / revive a retired thread"). Verify start order stays `RoutineEngine.recoverAtBoot` -> `startScheduler` (`index.ts:179-207`).
2. One sweep over `routine_triggers` only; delete the `scheduled_messages` branch. Add catch-up on boot and sweep-gap detection (a gap > sweep interval x N means the process slept).
3. Skip reasons written as `skipped` runs everywhere (replaces `skippedAt/skipCount/MAX_SCHEDULE_SKIPS=20`, whose client copy is duplicated).
4. Self-management: advertise `routines_update`/`routines_run` to the agent inside a run (Claude's `update_scheduled_task`), so a run can reschedule itself or stop.
5. Aliases: `/api/scheduled*` and `schedules_*` harness ops stay as **thin aliases** over the new model for one release (saved prompts/workflows call them), marked deprecated in their description. Same for `/schedules*` client paths (redirect). Rename harness tools `routines_*` -> `automations_*` with the old names kept as aliases. Fix stale text at `harness-tools.ts:794,803` (mentions a `script` body that does not exist).
6. Rate limit stays (`FIRE_RATE` 10/min, `MAX_LIVE_ROUTINE_RUNS=4`); surface hitting them as a skipped run, never a silent drop (Claude drops GitHub events silently, avoid that).
7. Auto-disable after repeated failure (e.g. 5 consecutive `failed`/connection errors) and SAY so in the inbox; neither product does this loudly.

## Client work

- Delete `schedule-page.tsx`, `lib/schedule.ts`; split `routines-page.tsx` (1050 lines) into `automations/` pages built on the kit; one `lib/queries/automations.ts`; one set of keys; `settings.ts` types merge (booleans, not 0/1).
- Rewire: sidebar nav (two rows -> one), landing chips, palette pages (`routine-pages.tsx`, `root-page.tsx` rows), `layout-options` "Tasks, Routines, Scheduled" toggle, `panel-kinds`, `project-page.tsx` (`useScheduled` -> automations by project), composer `/schedule` -> `/automate` + `core.ts createSchedule`.
- Tests to keep green: `test:scheduler` (pure `nextSlot/staggerMs/fnv1a`: keep those exports), `test:routines`, `test:git-trigger`, `backup.test.ts`. Add tests for: session-mode delivery, catch-up once, skip reasons, the migration, alias routes (none exist today for `createScheduled`/`/api/scheduled`).
- Docs: rewrite `docs/client.md` "Routines and schedules pages", update `docs/mcp-and-workflows.md:470-475`, `CLAUDE.md`/`AGENT.md` (they currently say the two are "not folded together"; that rule is what this plan reverses, so edit it deliberately).

## Phases

1. **Model + migration** (schema, `runsIn`, wrappers keep `workflows.ts` working, scheduled_messages migrated, aliases). Server tests.
2. **Engine behaviour**: catch-up, skip reasons, session-mode delivery, auto-disable, self-management tools.
3. **UI rebuild**: list, detail, form with presets + next-fire preview, template gallery, thread footer reading, sidebar/palette/landing rewiring, `/automate`.
4. **Inbox**: `run` rows in pending/notifications, auto-archive of quiet runs, unread badge.
5. **Cleanup**: drop aliases after a release, stop declaring `scheduled_messages` once migrated everywhere, docs.
Deferred: GitHub PR/release event triggers; per-run permission "Always allow" learning (start with the panel listing existing autonomy rules).

## Decisions needed (defaults chosen)

1. Name: **Automations** (default).
2. Keep DB table names, rename at the surface only (default) vs rename tables.
3. Inbox in phase 4, built on the existing pending/notifications page (default).
4. Aliases kept one release (default).
5. "Remove everything and recreate": this plan **reuses the engine, triggers, runs, git watcher, token door and onFinish** because they are sound and external webhooks/backups depend on them; only the schedule-message half and both UIs are replaced. Say so if you want the engine rewritten too.

## Sources

learn.chatgpt.com/docs/automations; developers.openai.com/codex/app/automations; code.claude.com/docs/en/routines, /desktop-scheduled-tasks, /scheduled-tasks; openai/codex#15310; third-party guides (simplified.guide, developersdigest.tech, builder.io). Daily-cap figures for Claude routines are third-party and unverified.

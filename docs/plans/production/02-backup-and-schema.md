# Phase 2: backups and schema safety

## Context

- **The backup belongs to the deploy, not to a person remembering.** Every schema change goes
  through `pnpm db:push`, and `pm2:start` runs `db:push` on every deploy
  (`server/package.json:11`). So the dump is taken *inside* `db:push`, which covers the deploy
  and a hand-run push alike. `server/src/db/index.ts:132` already claims "db:push first captures
  a full pg_dump under data/backups/"; this phase makes that comment true.
- **drizzle-kit does not fail when it should.** It exits 0 when its data-loss prompt is aborted
  and when a statement fails partway (`node_modules/drizzle-kit/bin.cjs:82571`, `:82609`), and
  hangs on the prompt without a TTY. So today `&&` carries on and pm2 reloads new code against
  an old schema.
- **The installed `pg_dump` cannot dump this database.** `/usr/bin/pg_dump` is 14.11, the server
  is PostgreSQL 18.6 (a pgdg Debian build, likely in a container). pg_dump refuses a newer server
  major. The client must be 18 (`postgresql-client-18` from apt.postgresql.org, or `docker exec
  <pg-container> pg_dump`).
- **Size.** 7.4 GB, of which 7.35 GB is `session_events` + `session_events_fts`. A custom-format
  dump is minutes, not seconds; 808 GB free on `/`.
- **The in-app export is not a backup.** `exportBundle` (`backup.ts:993`) selects the whole
  journal (1.95M rows) into one JSON string, and leaves out attachment and file bytes.

## Steps

0. **Prerequisite:** install `postgresql-client-18`, or decide on the `docker exec` form.
1. **`server/scripts/db-backup.ts`**, run with tsx:
   - Resolves the URL through `config.ts`'s `databaseUrl()`, the same answer `drizzle.config.ts`
     uses, so the dump and the push can never mean two databases.
   - The binary is `DAEDALUS_PG_DUMP` (default `pg_dump`, may be `docker exec -i <c> pg_dump`).
     Compares `pg_dump --version` major with `server_version_num` and **fails** on a mismatch,
     naming both versions.
   - `pg_dump -Fc --no-owner` to
     `data/backups/<UTC timestamp>-<git short sha>-<reason>.dump.partial`, renamed on success,
     verified with `pg_restore --list`; dir 700, file 600.
   - Retention: keep the last `DAEDALUS_BACKUP_KEEP` (default 7) per reason; prunes only its own
     files.
   - Any failure exits non-zero.
   - Decide while building: exclude `session_events_fts` data (`--exclude-table-data`) only if
     `ensureSearchIndex` repopulates it from `session_events`; otherwise it stays in.
2. **Wire it into the push** (`server/package.json`):
   - `"db:backup": "tsx scripts/db-backup.ts"`
   - `"db:push": "tsx scripts/db-backup.ts --reason predeploy && drizzle-kit push"` — the deploy
     and a hand-run push both dump first, and a failed dump stops before the schema or the code
     moves.
   - `"db:push:nobackup": "drizzle-kit push"` for test databases and emergencies only.
3. **Make a failed push fail the deploy.** Until migrations land, the push runs through a small
   wrapper that refuses to run without a TTY when push would prompt (or uses `--strict`), and
   turns an abort or a caught statement error into a non-zero exit.
4. **Scheduled backups.** A second pm2 app in `ecosystem.config.cjs` (`daedalus-backup`,
   `cron_restart: "30 3 * * *"`, `autorestart: false`) runs the same script with
   `--reason daily`, plus a tar of what is not in Postgres: `attachments/`, `files/`,
   `config.json`, `firebase-service-account.json`, `loopback-secret`. Copy off-host, encrypted,
   because the dumps hold secrets.
5. **Restore runbook** in `docs/ops.md`: `pm2 stop`, `pg_restore --clean --if-exists -d <url>`,
   restore the `data/` tar, `pm2 start`. Rehearse it once against a scratch database.
6. **Fix the in-app export.** Stream it instead of building one string, and default to
   `journals=0` (`client/src/components/settings/backup.tsx:153`). It is a portability tool; the
   pg_dump is the backup.
7. **Later: migrations instead of push.** `drizzle-kit generate` with committed SQL, applied
   under `pg_advisory_lock`, with `ensureSchema`'s hand-written DDL and the FTS table folded in
   as custom migrations. The backup step stays in front of it.

## Done when

- `pnpm pm2:start` leaves a verified `.dump` in `data/backups/` before the push runs.
- A failed dump, a version mismatch or an aborted push stops the deploy with a non-zero exit,
  and pm2 keeps the old code running.
- The daily job has produced a dump and a tar, and both reached the off-host copy.
- A restore into a scratch database has been rehearsed and the runbook matches what was done.

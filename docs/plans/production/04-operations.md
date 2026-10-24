# Phase 4: operations

## Context

- **Logs are never rotated.** `logs/error-16.log` is 121 MB after 15 days; pm2-logrotate is not
  installed. pm2 writes `out-16.log`/`error-16.log`, not the `out.log` the ecosystem names.
- **The restart policy can leave the server down.** Only `max_restarts: 10`
  (`ecosystem.config.cjs:49`): with Postgres down, `ensureSchema` throws at boot, the server
  crash-loops and pm2 gives up.
- **Shutdown is best-effort.** The journal flush and `retire()` writes are not awaited
  (`sessions.ts:942`); the pool's 10 s connect timeout outlasts pm2's 5 s `kill_timeout`;
  `server.close()` and `closeDb()` are never called.
- **A failed boot read is swallowed** (`sessions.ts` ~774): the server listens with no threads
  and `/api/health` still says ok.
- **The journal drops events** on a transient DB error (`session-journal.ts:127`); seen with
  57P01 and connection timeouts in the logs.
- **14.8k `POST /api/themes` 500s** on Oct 22: a duplicate id is a 23505 mapped to 500, and the
  client retried it.
- **Nothing caps live agent processes.** About 550 MB per thread (the agent plus 5-6 stdio MCP
  children); an open tab keeps one alive forever.
- **Growth without retention**: `pruneModelCalls` exists and nothing calls it; `wf_runs`,
  `routine_runs`, `session_turn_changes` and `~/.daedalus-agent` (1.8 GB) have none.
- **Postgres** runs on defaults and has not been analyzed since its Oct 23 restart.
- **`/api/fim`** returned 511 502s; the completion lane is failing.

## Steps

1. **Logs**: `pm2 install pm2-logrotate` (`max_size 50M`, `retain 10`, `compress`); fix the
   paths in `ecosystem.config.cjs`.
2. **Restart policy**: `exp_backoff_restart_delay: 1000`, `min_uptime: 10000`,
   `max_memory_restart`. Safe under `DAEDALUS_SANDBOX=hosted`.
3. **Shutdown**: await the journal flush and `retire()`, close the HTTP and WebSocket servers,
   `closeDb()`, all raced against a 4 s deadline.
4. **Boot**: exit non-zero when the sessions read fails. Validate `config.json` with zod and
   refuse to boot on a parse error; never reseed over an existing file.
5. **Health**: `/api/live` (process up) and `/api/ready` (`SELECT 1`, sessions ready, adoption
   bound).
6. **Journal**: requeue on connection errors with backoff and a bounded buffer.
7. **Errors**: map Postgres 23505/23503 to 409 in `onError`; theme create becomes an upsert; the
   client stops retrying a 4xx.
8. **Retention**: call `pruneModelCalls` from the hourly sweep; add retention for `wf_runs`,
   `routine_runs`, `session_turn_changes`; prune the agent store by last-touched time, or delete
   the agent session when its thread is deleted.
9. **Capacity**: a global `maxLiveProcesses` with LRU retirement of idle threads. Longer term,
   serve the built-in MCP servers once over HTTP instead of one stdio copy per thread.
10. **Postgres**: `ANALYZE session_events, session_events_fts`; tune `shared_buffers`,
    `effective_cache_size`, `work_mem`.
11. **`/api/fim`**: find out why the lane fails and fix it, or turn the lane off.
12. **Cleanup**: delete the 0-byte SQLite files in `server/data/` (they trigger a warning on
    every boot), and skip zero-byte files in that check.

## Done when

- Logs rotate, and stopping Postgres for a minute neither leaves pm2 errored nor loses journal
  rows.
- `/api/ready` fails while Postgres is down and recovers by itself.
- `error.log` has no recurring 500s for a day.
- Live processes stay at or under the cap under load.

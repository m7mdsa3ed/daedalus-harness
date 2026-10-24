# Phase 1: lock down access

## Context

- **The token is the owner's choice, and stays that way.** `data/config.json`'s `token` is set
  by hand; this plan does **not** generate, lengthen or reject it. What makes a short, chosen
  token survivable is everything around it: no oracle that says whether a guess was right, a
  throttle on failures, constant-time comparison, and never writing it to a log.
- **The token is shell access.** It opens `/terminal`, `POST /api/sessions/:id/shell`, agent
  `command`/`args`, `/api/backup?secrets=1` and `sync-export?secrets=1`.
- **Today:** `/api/health` answers `authorized: token === config.token` unauthenticated
  (`server/src/routes/misc.ts:141`), CORS is `*` (`index.ts:229`), the server binds `0.0.0.0`
  (`config.ts:161`), the token is printed on every boot (`index.ts:309`, 71 times in
  `logs/out-16.log`), and `config.json` / `firebase-service-account.json` are 0644 with a second
  local account (`ubuntu`) on the machine. A cloudflared tunnel is running.

## Steps

1. **Remove the token oracle.** `/api/health` stops returning `authorized`. The client checks a
   token with an authenticated `GET /api/meta` instead (connect screen and the compat gate). The
   `api`/`minClientApi` fields stay public, because the compat gate needs them before a token is
   known good.
2. **Throttle failed auth per IP** on `/api/*`, the WebSocket upgrade and `/terminal`
   (`index.ts:255`, `:393`): 10 failures per minute, then exponential lockout, answered as 429,
   held in memory (one instance, fork mode). Successful requests are never counted. Behind
   cloudflared the IP is `CF-Connecting-IP`, trusted only when the peer is loopback.
3. **Constant-time compare** at all four sites (`index.ts:255`, `:393`, `misc.ts:141`, `:303`)
   through the existing `safeKeyEqual` (`gateway-shim.ts:87`).
4. **Never log the token.** `index.ts:309` prints a fingerprint (first 2 chars + length);
   `onError` (`index.ts:239`) redacts `/(gw|mx|ph|otlp|wf|hm|rt)/<key>` from paths.
5. **Permissions.**
   - `writeJson` (`config.ts:148`) writes with `{ mode: 0o600 }`.
   - Boot chmods `data/` to 700 and `config.json`, `firebase-service-account.json` to 600, as it
     already does for `loopback-secret`.
   - One-off: `chmod 700 server/logs`, `chmod 600 server/logs/*`, then delete the old logs that
     hold the token and rotate `loopback-secret`.
6. **Bind and CORS.**
   - Default `host` to `127.0.0.1` and set it in `config.json`; publish only through the tunnel.
   - `cors()` takes an origin list from config (the PWA origin, the Electron static origin).
   - No CORS at all on the loopback doors (`/gw /mx /ph /otlp /wf /hm /rt`) and `/oauth`.
7. **Cloudflare Access** in front of the tunnel hostname (outside the repo, recommended).

## Done when

- A wrong token gets 401s, then 429s.
- `/api/health` has no `authorized` field.
- `ss -ltnp` shows `127.0.0.1:4001`.
- `grep -r <token> server/logs` finds nothing.
- `stat` shows 600 on `config.json` and the service account, 700 on `data/`.

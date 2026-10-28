# Daedalus Harness — First run: from `git clone` to a running thread, configured from the app

## Context

Today a new install is a page of terminal steps followed by a page that thinks it is done
before it is. The goal is the reverse: the terminal does only what has to happen before a
browser can exist (prerequisites, install, schema, start), and everything after that —
which agent, whether it is installed, logging it in, the first profile, the first project,
the first thread, and the optional rest — happens in the app. On the desktop, even the
terminal half becomes the app's, over SSH.

What exists, measured on 2026-10-28:

- **The landing page has a two-step setup** (`client/src/components/landing/landing-setup.tsx`):
  "Create a project" and "Add a profile", gated in `app-shell.tsx:132` by
  `ready = !loading && projects.length > 0 && profiles.length > 0`.
- **That gate is wrong in a way a new user hits first.** `useProfiles()` includes every
  agent's virtual `default:<agentId>` profile (`server/src/profiles.ts`, "Every agent's
  virtual default, then the stored profiles"), so the profile step is always "done" — even
  when no agent is installed or logged in. The real blockers are *an agent that is installed
  and authenticated* and *a project*, and the gate reads neither.
- **Whether an agent is installed is already measured** (`server/src/agent-status.ts`):
  the binary on PATH plus one ACP `initialize` handshake, cached 5 min, `?refresh=1` past it.
- **Installing is already a route** (`POST /api/agents/:id/install` → `installAgent`,
  `agent-status.ts:226`): runs the row's `install` line (`registry.ts:613`,
  `INSTALL_COMMANDS`) with `execFile`, 10 min timeout, answers `{ok, output}`, evicts the
  status. Settings › Agents calls it (`settings/agents.tsx:112`). The wizard reuses it as is.
- **Logging in is not handled anywhere.** The harness never reads `authMethods` and never
  calls ACP `authenticate`. A runtime that is not logged in shows up as a failed turn, or as
  `"unauthenticated"` in the quota probe (`quota.ts:367`, `:453`), which already reads the
  plain CLI's own answer.
- **The README is stale**: it documents `data/mcp-servers.json` / `data/agents.json`,
  port 8791 (pm2 deploys on 4001), and says nothing about PostgreSQL or `db:push`.
- **A fresh database has no tables until `db:push`**, and only `pm2:start` runs it;
  `pnpm dev` on a fresh database boots against nothing.
- **Terminals are project-scoped** (`terminals.ts:152`, `createTerminal(projectId, …)`
  resolves the project's cwd and 404s without one). Login happens before any project exists.

## The load-bearing finding: both adapters already say how to log in, over ACP

Read from the installed packages, not their docs.

**`claude-agent-acp`** (`dist/acp-agent.js`, `initialize`): when the client's capabilities
say `auth.terminal: true` (or `_meta["terminal-auth"]: true`), the answer carries
`authMethods` of `type: "terminal"`, each with the `args` to run the adapter's **own
binary** with (`--cli auth login --claudeai` for a subscription, `--cli auth login
--console` for API billing). With `_meta["terminal-auth"]` the method carries the full
`{command, args, label}`. It decides between the two shapes by checking for a remote
session — `NO_BROWSER`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `CLAUDE_CODE_REMOTE` —
and on a remote one offers a single `claude-login` method (`--cli`, i.e. `/login`), which
prints a URL and takes a pasted code. It also advertises `auth.logout`, and an empty
`agentCapabilities._meta.authStatus` marker — which means only "this agent *pushes* its
identity" (`dist/auth-status.d.ts`): the identity arrives as an `_auth/status_update`
notification, first from an asynchronous probe `initialize` starts and does not wait for,
then on `authenticate`/logout, each `createSession` and the start of each prompt, and only
when it changed. **Silence means "cannot tell"; `kind: "none"` means logged out.** It is
never a field of the `initialize` answer.

**`codex-acp`** (`getCodexAuthMethods`): always `api-key`; `chat-gpt` (browser login on the
host) unless `NO_BROWSER`; and **`chat-gpt-device-code` only for a client that supports URL
elicitation** — which we already advertise (`acp-bridge.ts:425`,
`elicitation: { form: {}, url: {} }`). `authenticate {methodId: "chat-gpt-device-code"}`
starts the login, sends a **URL elicitation** (`verificationUrl`, message "Sign in to
ChatGPT and enter this code: …"), and resolves when the login completes or the elicitation
is declined (which cancels it).

So the harness needs **no vendor's login command**. The agent says what its methods are;
the harness runs the two generic shapes:

| Method shape | What the harness does | Works on a headless server |
| --- | --- | --- |
| `type: "terminal"` | Runs `command + args` (from `_meta["terminal-auth"]`, else the row's own `command` + the method's `args`) in a server PTY drawn as a terminal panel. The person opens the URL it prints and pastes the code back. | Yes — the PTY is the round trip |
| no `type` (agent-handled) | ACP `authenticate {methodId}` on a held connection; any URL elicitation it raises is drawn with the existing URL-elicitation UI. | Yes for device-code; `chat-gpt` (browser on host) is not offered under `NO_BROWSER` |
| `api-key` style | Not a login: it is what a profile's credentials are. The wizard sends the person to the profile step. | — |

This follows the existing rules: what the harness believes about a runtime comes from the
runtime (ACP), not from a comparison against its id; and nothing a browser types becomes a
command — the line comes from the agent's own answer or the row.

## Design

### Phase 1 — Agents: detect, install, log in (server + one shared client component)

**Server**

1. **Advertise terminal auth.** Add `auth: { terminal: true }` and
   `_meta: { "terminal-auth": true }` to `CLIENT_CAPABILITIES` (`acp-bridge.ts:392`).
   Every runtime then tells us its login methods in `initialize`. (Check before landing:
   that advertising it changes nothing else in either adapter's `initialize` answer.)
2. **Return `authMethods` from the status probe.** `agent-status.ts` already holds the
   `initialize` answer (`:318`); add `authMethods: AuthMethod[]` to `AgentStatus`, passed
   through as ACP said it. The client draws them generically.
3. **Spawn the status probe with `NO_BROWSER=1` — in the probe's own spawn env only.** A
   server under pm2 has no `SSH_*` env, so claude-agent-acp would offer the browser-on-host
   methods and codex would offer `chat-gpt`, neither of which reaches a person who is not at
   the server's screen. `NO_BROWSER` makes both pick the methods that work remotely. The
   probe already runs a process of its own (`withAgentConnection` → `spawnAgent`,
   `probe.ts:250`), so the flag cannot reach a thread **as long as it is set on that spawn's
   env and never on `process.env` or a stored profile** — that is the rule, and a test
   asserts it. ponytail: always on; a per-server "this host has a screen" switch is for
   when someone runs the server on their own desktop and wants the browser flow.
4. **Is it logged in — measured, never assumed.** Add `authenticated: boolean | null` to
   `AgentStatus`. claude-agent-acp's identity is **pushed, not answered** (see above), so
   the probe subscribes to `_auth/status_update` *before* `initialize`, keeps the last
   payload, and waits a bounded moment (the adapter's own CLI probe is capped at 5 s,
   `AUTH_STATUS_PROBE_TIMEOUT_MS`) after `initialize` for it: `kind: "none"` → `false`, any
   other kind → `true`, silence → fall back to the quota probe's existing classification
   (`"unauthenticated"` → `false`), and still nothing → `null`. `null` is drawn as "not
   checked", never as logged out. Never read the capability marker as a status.
5. **Terminal login.** `POST /api/agents/:id/login {methodId}`: takes **only** `methodId`,
   looks it up in the *probed* `authMethods` and refuses any id the probe did not return.
   The command is `_meta["terminal-auth"].{command,args}` when present, else the row's
   `command` + the method's `args` — **an argv, spawned without a shell** (`createTerminal`
   grows an `argv` option beside today's `command`, which `shellFor` runs as `sh -l -c`).
   It needs a terminal that belongs to no project: `createTerminal` gets a reserved
   `"setup"` id whose cwd is **pinned** to the server user's home, which **ignores any
   caller `cwd`/`env`**, and which only this route can create — `POST
   /api/projects/setup/terminals` stays a 404. The status probe runs in the same home
   directory, so the probe and the login see the same `.claude`/`.codex`. The panel attaches
   with the existing terminal socket. On exit, step 7.
6. **Agent-handled login.** `POST /api/agents/:id/authenticate {methodId}`: takes **only**
   `methodId`, refuses any id the probe did not return, and **never forwards `_meta`** —
   codex-acp's `authenticate` also accepts `api-key` (reading the key from
   `_meta["api-key"]`) and `gateway` (arbitrary gateway settings), so a forwarded body would
   plant credentials or a gateway through a login door. Credentials stay the profile's.
   It opens a fresh connection (`withAgentConnection`, `probe.ts`) — never a thread's —
   calls `authenticate`, and **holds it** while the agent elicits. The elicitation has no
   thread to land in, so the route streams: an SSE stream of `{elicitation}` → `{done, ok}`,
   the client drawing the elicitation with the existing URL-elicitation component and
   posting accept/decline to `…/authenticate/:requestId`. **The stream owns the
   connection's life**: on the client closing it, or a timeout (10 min, the device code's
   own lifetime order), the route declines the pending elicitation (which makes codex call
   `accountLoginCancel`), closes the connection, and releases the lock. ponytail: one
   stream per agent at a time; a second request is a 409 — released by the cleanup above,
   so it can never stick. On success, step 7.
7. **A login reaches processes that already exist.** `initialize` runs once per process
   (`acp-connection.ts`), and codex's `authenticate` answers `true` without logging in when
   the process it runs on already has a working login — so a login must be measured where
   threads will run, not where it happened. After a successful login (or a login terminal
   exiting): evict the agent's status, and **retire that agent's idle shared processes**
   (`sharedProcess` rows; the warm 5-minute pool) so the next thread spawns on the new
   login. A process with a turn running is left alone — claude-agent-acp re-reads the
   account at the start of each prompt and recreates a session whose account changed at the
   next turn boundary; a process of its own (codex) picks it up on its next spawn. **The UI
   says whose login it is**: the server's OS user's, shared by every thread and every
   person on the server — the same as a CLI login today, never a per-person one.

**Client**

8. **One `AgentSetupRow`** (agent mark, installed/version, logged-in state, and the one
   button that moves it forward: **Install** → **Log in** → done), used in three places:
   Settings › Agents, the wizard's first step, and the 424 "missing agent" notice in a
   thread, which today points at Settings › Agents with the install line.
   Logging in with several methods is a `ChoiceTiles` of them, named as the agent named them.

### Phase 2 — The wizard (client)

Replace `LandingSetup` with a stepper on the same landing slot. **Every step's state is read
from what exists, never from a "setup done" flag**, so deleting the last project brings the
wizard back on its own and two devices agree.

1. **Agents** — `AgentSetupRow` per runtime. Done when at least one agent is installed and
   not `authenticated === false`. The others can stay as they are.
2. **Profile** — "Use my login" (the agent's virtual Default, which now means something
   because step 1 measured it) or "Use an API key / plan" (the existing profile form,
   prefilled from `profile-presets.ts`). Done when a ready agent has a Default, or a stored
   profile exists.
3. **Project** — the existing project form: name and directory (`ensureProjectDir`).
4. **First thread** — the landing composer, with the project and the pair from steps 1–3
   already set, and a starter suggestion ("Tell me about this repository"). Sending it
   ends the wizard, because there is now a thread.

**Fix the gate**: `ready` counts a profile only if it is stored, or virtual *and* its agent
is installed and not known to be logged out.

**Unknown is two answers, on purpose.** `authenticated === null` (nothing pushed, quota
silent) **passes the shell's `ready` gate** — a runtime that cannot report its login must
not lock someone out of an app it may well work in — but **does not mark the wizard's
Agents step done**: the step shows "Not checked" with Log in still offered. Only
`authenticated === true` ticks it. `false` blocks both.

**Optional, after the first thread** — a "Finish setting up" card on the New tab page, each
row deep-linking into the settings page that already exists, and each one hiding itself
once it is done (measured): import MCP servers and skills (`GET /api/import`), global rules,
notifications (FCM), theme. No new forms.

### Phase 3 — `setup.sh` (repo root)

What has to happen before any browser can:

1. Check Node ≥ 22, pnpm, git — print the install line for any that are missing, and stop.
2. Check PostgreSQL is reachable at `DATABASE_URL` (else the default URL); create the
   `daedalus` database if the server answers but the database does not exist. **Do not
   install PostgreSQL**: print the command for the host (apt / brew / `docker run postgres`)
   and stop. Installing a database is invasive and per-OS.
3. `./build.sh --install all`, then `pnpm --dir server db:push` — **always, before any
   start**, pm2 or not (today only `pm2:start` pushes, and `pnpm dev` on a fresh database
   boots against no tables).
4. Start the server (`pm2:start` when pm2 is present, else print `pnpm --dir server serve`).
5. Print one connect link: `http://<host>:<port>/?server=<url>&token=<token>`.
   The connect screen (`connect-screen.tsx`) reads `server` and `token` from the query and
   **strips them from the URL immediately on read** (`history.replaceState`) — before
   verifying, so a failed verify never leaves the token in the address bar — holding them
   in memory to prefill and verify against `/api/health` exactly as a typed one is. The
   token is still in shell history and the browser's history once: acceptable for a link
   printed to the operator's own terminal. Never logged.

Flags, because Phase 4 drives the same script over SSH:

- `--yes` — non-interactive.
- `--dir <path>` — the checkout to set up. **Never clones into an existing checkout**: if
  `<path>/setup.sh` exists it is used as is; a non-empty directory that is not a checkout
  is refused.
- `--local` — writes `host: "127.0.0.1"` into `data/config.json`, so SSH is the server's
  only door (Phase 4 step 7).
- `--port <n>` — the port to bind, so Phase 4 can pin it.

Idempotent: a second run skips what is already true.

Rewrite the README's Run section to: clone, `./setup.sh`, open the printed link.

### Phase 4 — SSH from the desktop app (Electron only)

A browser cannot open SSH, so this is the desktop shell's: the connect screen grows an
**SSH** tab beside URL + token.

0. **Is there an `ssh` at all** — main looks for the binary on PATH (`where ssh` on Windows,
   where the OpenSSH client is optional). None: the SSH tab is not drawn, and the connect
   screen says why and how to add it. All paths are `os.homedir()`-based, never `~` strings.
   The *client* may be Windows; the *host* is POSIX (`setup.sh` is bash).
1. **Host** — free text, or picked from `~/.ssh/config` `Host` entries (read in main).
2. **Trust the host, explicitly, once.** `StrictHostKeyChecking=accept-new` trusts whatever
   key a host shows the first time, and with `--local` SSH is the server's *only* door, so a
   forged first connect is the whole boundary. Instead: if `ssh-keygen -F <host>` finds no
   key, main runs `ssh-keyscan`, the screen shows the fingerprint(s) and asks the person to
   confirm them against the host, and only a confirmed key is appended to the user's
   `known_hosts`. Every later `ssh` runs with `StrictHostKeyChecking=yes`. Never
   `UserKnownHostsFile=/dev/null`.
3. **Connect** — main spawns the system `ssh` (the user's keys, agent and config; no new
   dependency): `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes host …`.
   ponytail: key auth only; a password or passphrase prompt is for when someone needs it,
   and would need a PTY in main.
4. **Find or install** — `ssh host test -f <dir>/server/data/config.json`. Missing: offer
   to install — `git clone` into `<dir>` (default `~/daedalus-harness`, editable) only when
   `<dir>` does not exist, then `setup.sh --yes --local --dir <dir> --port <port>`, streamed
   into the screen. A missing prerequisite stops with `setup.sh`'s own message.
5. **Tunnel, on a fixed port.** The local port is **chosen once per saved host and
   stored**, never picked fresh per launch: the renderer's origin includes the port, and
   localStorage, the saved server list, the service worker and the push subscription are
   all per origin — a new port every launch is a new, empty app. Main runs
   `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
   -L 127.0.0.1:<port>:127.0.0.1:<server port> host`. **One tunnel per saved host**, keyed
   in main (two clicks or two windows reuse it); restarted with backoff when it dies; killed
   on `before-quit`. A port taken by something else at launch is an error naming it, not a
   silent re-pick. `status: {state, port, error}` goes to the renderer over IPC.
6. **Token** — read over SSH from `data/config.json`; never typed. The saved server entry
   records `{ssh: {host, dir, port}}` so a relaunch opens the tunnel *before* connecting.
   While the tunnel is down, threads go through the existing reconnect ladder — the tunnel
   dropping is a socket closing with no code, which already reattaches and never respawns.
7. **Bind locally** — `setup.sh --local` writes `host: "127.0.0.1"` into `config.json`, so a
   server installed this way has **no public port**: SSH is its only door.

IPC is the existing `ipcMain.handle` pattern (`electron/main.cjs`); the renderer sees
`desktop.ssh.{hosts, connect, install, status}` through `lib/desktop.ts`.

## Files

| Phase | File | Change |
| --- | --- | --- |
| 1 | `server/src/acp-bridge.ts` | `auth.terminal` and `_meta["terminal-auth"]` in `CLIENT_CAPABILITIES` |
| 1 | `server/src/agent-status.ts` | `authMethods`, `authenticated`; probe spawned with `NO_BROWSER=1` in its own env, cwd = home |
| 1 | `server/src/probe.ts` | subscribe to `_auth/status_update` before `initialize` |
| 1 | `server/src/terminals.ts` | the pinned `"setup"` root; an `argv` option spawned without a shell |
| 1 | `server/src/acp-connection.ts` | retire an agent's idle shared processes after a login |
| 1 | `server/src/routes/profiles.ts` | `POST /api/agents/:id/login`, `POST /api/agents/:id/authenticate` (+ answer) |
| 1 | `server/src/compat.ts` | `FEATURES` entry `agentLogin` (additive, no bump) |
| 1 | `client/src/components/settings/agents.tsx` | `AgentSetupRow`, used here first |
| 1 | `client/src/components/thread-view/thread-status.tsx` | 424 notice draws `AgentSetupRow` |
| 2 | `client/src/components/landing/landing-setup.tsx` | the four-step wizard |
| 2 | `client/src/components/app-shell.tsx` | the corrected `ready` gate |
| 3 | `setup.sh`, `README.md` | new script; Run section rewritten |
| 3 | `client/src/components/connect-screen.tsx` | `?server=&token=` prefill and strip |
| 4 | `client/electron/main.cjs`, `preload.cjs`, `client/src/lib/desktop.ts` | SSH IPC |
| 4 | `client/src/components/connect-screen.tsx` | the SSH tab |
| all | `docs/architecture.md`, `docs/client.md`, `CHANGELOG.md` | the rules that change |

## Verification

No visual testing (CLAUDE.md). Per phase:

- **1**: `pnpm exec tsc --noEmit` (server), `pnpm exec tsc -b` (client); one server test
  that the status probe passes `authMethods` through, that both login routes refuse a
  `methodId` the probe did not return and drop a body's `_meta`, that `NO_BROWSER` is on
  the probe's spawn env and absent from a thread's, that `kind: "none"` reads as `false`
  and silence as `null`, and that closing the authenticate stream releases the 409. By hand: log claude out (`claude-agent-acp --cli
  auth logout`), see the row say so, log in from the panel; the same for codex by device code.
- **2**: on a fresh database (`DAEDALUS_DATA_DIR=/tmp/… DATABASE_URL=…/daedalus_fresh`),
  the wizard opens, and the gate does not pass with only virtual profiles and no agent.
- **3**: `setup.sh` on a clean checkout in a container with and without PostgreSQL; a
  second run changes nothing.
- **4**: against a VM reachable by key: install, tunnel, connect, drop the network,
  reconnect.

## Open questions

- **Does advertising `auth.terminal` change anything else** in either adapter's
  `initialize`? Read in the source it only gates the terminal methods, but diff both
  live answers before and after anyway.
- **How long to wait for claude's first `_auth/status_update`** — the adapter caps its own
  CLI probe at 5 s; whether the status route should wait that long on every cold read, or
  answer `null` and update on the push, is decided when the route's latency is measured.
- **Windows hosts over SSH** — `setup.sh` is bash. Out of scope until someone asks; WSL
  covers the case today. (A Windows *client* is in scope — Phase 4 step 0.)

## Review (2026-10-28)

Reviewed by Codex against the installed adapters (claude-agent-acp 0.89.1, codex-acp);
its findings were checked against the code before being folded in.

- **Folded in**: `authStatus` is push-only (Phase 1 step 4, confirmed in
  `dist/auth-status.d.ts`); a login must reach existing shared processes and is the OS
  user's (step 7); both login routes take only `methodId` and never forward `_meta`
  (steps 5–6); the authenticate stream owns its connection's cleanup (step 6); the setup
  terminal is pinned and spawned without a shell (step 5); one cwd for probe and login
  (step 5); the "unknown" gate semantics (Phase 2); `setup.sh` flags, `db:push` before any
  start and the token stripped on read (Phase 3); host-key confirmation instead of
  `accept-new`, a fixed per-host tunnel port, tunnel lifecycle, Windows `ssh` detection
  (Phase 4).
- **Rejected**: "`--cli` is appended twice in the remote case". The method's args are
  `process.argv.slice(1)` + `--cli`; launched as `claude-agent-acp`, `argv.slice(1)` is the
  script path alone, so `--cli` appears once. The advice it came with — spawn an argv, not a
  shell line — stands and is in step 5.
- **Narrowed**: "`NO_BROWSER` leaks into real threads". The probe already spawns its own
  process (`probe.ts:250`), so it cannot, provided it is set on that spawn's env and never
  on `process.env` — kept as a rule and a test (step 3), not a design change.

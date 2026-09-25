# Daedalus Harness — Remote hosts over SSH, through a bridge (replaces the multi-server list)

## Context

Today a project's `cwd` is a path on the machine the server runs on, and everything the
harness does for a project — the agent process (`acp-bridge.ts` `spawnProcess`), terminals
(`terminals.ts` `pty.spawn`), git (`git.ts` `execFile`), `!` lines and helpers
(`shell.ts` `runShellLine`), and the file routes (`workspace-fs.ts`, `fs.ts`,
`workspace-watch.ts`) — runs on that machine. The only way to work on another machine is
to install a second server there and switch to it in the client (`daedalus.servers` in
`client/src/lib/settings.ts`), which splits threads, profiles and the library per machine.
The unified view in `multi-server.md` was planned to paper over that split and was never
built; this plan supersedes it.

The goal: **one server, many machines.** A project names the host it lives on; the server
reaches that host over SSH and runs the project's work there, through a small **bridge**
the server installs on the host. The database, the journal, profiles, the library, auth and
push stay on the one server.

## Research that decided the shape

- VS Code Remote-SSH, Cursor, JetBrains Gateway and Zed all put a **version-pinned program
  on the remote** and talk to it over one SSH connection. We do the same, and keep it
  small: the bridge runs processes, files and watches — it owns no state worth keeping.
- **System `ssh`, not the `ssh2` package.** `ssh2` accepts any host key unless we write our
  own `known_hosts` parser, reads no `~/.ssh/config`, has no ProxyJump, and has not released
  since Aug 2025. The system binary gives the user's config, `known_hosts`, ProxyJump,
  ssh-agent, certificates and hardware keys for nothing. Zed made the same call.
- **ACP is stdio**, and the bridge relays a child's stdio byte for byte. The ACP bridge, the
  pool and the journal do not learn that a process is remote.
- **Cursor's remote bugs are mostly version pairing.** So the bridge's identity is the hash
  of its own bytes, and the server refuses a bridge that reports any other.

## Decisions

1. **A host is a row, and a project names one.** New table `hosts (id, name, target,
   node_path, os, arch, checked_at, created_at)`. `target` is exactly what the user would
   type after `ssh` — a `~/.ssh/config` alias or `user@host[:port]`; user, port, key and
   jump host are the SSH config's, never ours. `node_path`, `os`, `arch` are **measured**
   by Test, never typed. **No secrets in the row.** `projects.host_id` nullable; null is
   this machine, which stays the default and never touches the bridge.
2. **One seam: `server/src/host.ts`.** `hostOf(project)` answers a `Host` with `spawn`,
   `exec`, the file ops and `watch`. `local` is today's calls moved, unchanged; `remote`
   sends them to the host's link. **No call site spells `ssh` or knows the bridge exists**
   — the same rule `registry.ts` sets for vendor names.
3. **The bridge is one plain `.mjs` file with no dependencies** (`server/remote/bridge.mjs`,
   read at runtime like `test/fake-agent.mjs` — no build step, no bundler). `node:`
   builtins only, Node ≥ 18 (the *host's* Node, not ours). **No native modules**, which is
   why terminals do not go through it (decision 7).
4. **One `ssh` process per host is the link**, the bridge its remote command:
   `ssh -T -o BatchMode=yes <ControlMaster opts> <target> '<node_path>' ~/.daedalus-bridge/<hash>/bridge.mjs`.
   Everything for that host — every agent, every git call, every file read — is a message
   on it. No port opened on the host, no per-call SSH channel.
5. **Auth never prompts.** `BatchMode=yes` always: a key needing a passphrase must be in the
   server's ssh-agent (`SSH_AUTH_SOCK` under pm2), and an unknown host key is an error,
   never auto-accepted. Test says which, and offers **"Open in terminal"** — a *local*
   terminal running `ssh <target>` — so the first connection's host-key question and
   passphrase are answered where a PTY can answer them. That reuses `terminals.ts`.
6. **Secrets travel inside the link, never on a command line.** A spawn's env (the profile's
   API keys) is a field of the `spawn` message; the bridge passes it to `child_process.spawn`.
   It never reaches argv, a file, or the remote's `ps`.
7. **Terminals are `ssh -t`, not the bridge.** A PTY on the host would need `node-pty`, a
   native module per OS/arch/ABI. The local `node-pty` running `ssh -t` over the same
   ControlMaster already is a remote PTY.
8. **The multi-server client goes.** One `{url, token}` again; the connect screen stays,
   because a phone's browser still needs to reach the one server.

## The bridge

### Install (on first link, and whenever the hash moves)

1. `ssh <target> sh -c '…'` probe, one round-trip: `uname -sm`, `$HOME`, and the Node path
   from a **login** shell (`sh -lc 'command -v node; node -v'`) — nvm and friends only put
   `node` on `PATH` there. Stored on the row as `node_path`/`os`/`arch`. No Node ≥ 18 →
   Test says so and names the install; nothing else about the host is attempted.
2. `test -f ~/.daedalus-bridge/<hash>/bridge.mjs || (mkdir -p … && cat > ….tmp && mv ….tmp …)`
   with the file on stdin. `<hash>` is the sha256 of the file's bytes, so a changed bridge
   is a new directory and an old server's bridge is never overwritten under it.
3. Remove every sibling `<hash>` directory but the newest two.
4. Start the link (decision 4). The bridge hashes itself and prints
   `DAEDALUS-BRIDGE <hash>` as its first line; the server **discards everything before
   that line** (a `.bashrc` that prints is not an error) and closes the link if the hash
   differs.

### Wire

Newline-delimited JSON both ways over the link's stdio. Bytes are base64 in a string
(`ponytail:` 33% overhead on ACP traffic, which is text and small; binary frames if it
ever shows).

- **Calls**: `{id, op, …args}` → `{id, result}` | `{id, error:{code, message}}`. `code` is
  the Node errno (`ENOENT`, `EACCES`) so `workspace-fs.ts`'s existing error mapping holds.
- **Processes**: `spawn {cmd, args, cwd, env}` → `{pid}`; then events
  `{ev:"out"|"err", pid, data}` and `{ev:"exit", pid, code, signal}`; calls
  `stdin {pid, data}`, `stdin_end {pid}`, `kill {pid, signal}`. `env` is merged over the
  bridge's own environment (the host's `PATH`, `HOME`), never the server's.
- **Exec**: `exec {cmd, args, cwd, env, input?, timeoutMs, maxBuffer}` →
  `{stdout, stderr, code, signal, killed}` — `execFile`'s answer, so `git.ts` and `shell.ts`
  keep their error handling. `input` is `git apply -`'s patch.
- **Files**: `stat`, `readdir` (with types), `read {path, max}`, `write {path, data}`
  (temp + rename), `mkdir`, `rename`, `rm`, `realpath` (resolves `~` for the folder picker),
  `walk {root, ignores, max}` and `grep {root, pattern, ignores, max}`. The last two exist
  because a tree walk as `readdir` calls is a round-trip per directory; they are the node
  half of `workspace-fs.ts`'s search, moved.
- **Watch**: `watch {path, recursive}` → `{wid}`, then `{ev:"fs", wid, path}`; `unwatch`.

**Stdin is the lifeline.** When the link drops, the bridge's stdin ends and it kills every
child it started, in one place. Nothing is left running on the host with no one to answer
it (until phase 7 makes that deliberate).

### Server side (`server/src/remote/link.ts`)

- `HostLink` per host: lazily started on first use, one in-flight install, request map,
  event routing by `pid`/`wid`. Dropped → every open `RemoteProcess` emits `exit` and every
  call rejects `503 host unreachable`; the next call starts a new link with backoff.
- `RemoteProcess` is the subset of `ChildProcess` the harness uses, and no more: `stdin`,
  `stdout`, `stderr` as streams (`Readable.toWeb` in `acp-bridge.ts:396` takes them as is),
  `on("exit"|"error")`, `kill(signal)`, `exitCode`, `signalCode`. A dropped link is an
  `exit` with a null code, which is the crash path a thread already survives: the next send
  revives it with `session/load` from the agent's own store.

### Loopback URLs

Everything the harness hands an agent as `http://127.0.0.1:<port>/…` — the gateway shim
(`gateway-shim.ts:174`), the MCP OAuth shim (`mcp-shim.ts:69`), the workflow
(`workflows.ts:209`) and routine (`routines.ts:750`) endpoints — is unreachable from the
host. **SSH already forwards ports, so the bridge does not**: on first use per host,
`ssh -O forward -R 0:127.0.0.1:<serverPort> <target>` on the master answers the remote
port, and the URL builders take the host and use it. The key in each path is still the
credential; the forward listens on the host's loopback only.

## Phases

### 1. Hosts, the link, the folder picker

- `db/schema.ts`: `hosts`; `projects.host_id` (FK, `ON DELETE RESTRICT` — a host with
  projects cannot be removed out from under them). `pnpm db:push`. Backup carries `hosts`.
- `ssh.ts` (base args, ControlMaster at `<data>/ssh/%C` — `%C` is a hash, which keeps the
  socket path under ~104 chars), `remote/bridge.mjs` with the handshake and the file ops,
  `remote/link.ts`, `host.ts`.
- Routes: `GET/POST/PATCH/DELETE /api/hosts`, `POST /api/hosts/:id/test` (probe, install,
  handshake; answers `{ok, os, arch, node, error?}` with ssh's stderr on failure).
- `fs.ts` `listDirectory` goes through `host`, so the folder picker browses the host. The
  stored cwd is always absolute (`realpath` at save).
- Client: Settings › Hosts (a `Group` of rows: name, target, reading, Test, Open in
  terminal); the project form gains a host select above the folder picker. Changing a
  project's host warns: its threads' agent stores are on the old host, so they will not
  resume.

### 2. Agents on the host

- `spawnProcess(spec)` → `host.spawn(spec)`. `AcpPool.key` includes the host id, so a
  shared process is never shared across machines.
- Shim URLs through the forward.
- `materialize.ts` writes skills/commands through `host` file ops.
- `agent-status.ts`, `model-catalog.ts`, `quota.ts`: measured per host via `exec`. The
  option probe (`probe.ts`) caches per (host, agent).
- **Built-in MCP servers are skipped on a remote host** until phase 5, and land in
  `skipped` — the bargain an unconnected OAuth row makes. They are `process.execPath` + a
  local script (`sessions.ts:483`), which the host does not have. User stdio MCP rows run
  on the host as written; their command must exist there.

### 3. Git, `!` lines, helpers, terminals

- `RepoContext` gains `host`; `git.ts`'s `execFile`s (the runner and `git apply`) go
  through `host.exec`. Snapshots, worktrees, revert and source control follow — all git.
- `shell.ts` `runShellLine` through `host.exec`; project helpers open a terminal as today.
- `terminals.ts`: for a remote project, `pty.spawn("ssh", [...base, "-t", target, "--",
  "cd '<cwd>' && exec \"$SHELL\" -l"])` locally (POSIX-quoted). Terminal env is not
  secret and is inlined.

### 4. Files and watching

- `workspace-fs.ts`, `mentions.ts`, `project-scripts.ts`, `project-stats.ts`,
  `attachments.ts`: through `host`. `containedPath` stays the check, on the server,
  against the host's path string (both ends POSIX).
- `workspace-watch.ts` subscribes through `host.watch`; the bridge's `fs.watch` runs next
  to the files, so the file tree and source control update as they do locally.

### 5. What phase 2 skipped

- **Built-in MCP over the link.** The bridge also listens on a unix socket in its own
  `0700` directory; the agent is given the stdio command
  `<node_path> ~/.daedalus-bridge/<hash>/bridge.mjs mcp <name>`, which connects to that
  socket; the bridge relays it as a stream, and the server runs the built-in *locally*
  (`process.execPath`, as today) on the other end. Stdio end to end; the built-ins change
  nothing.
- OpenCode's subagent sidecar (`acp-bridge.ts:145`, a port the agent listens on): an
  `ssh -O forward -L`.
- `routine-git-trigger.ts`: ref writes through `host.watch`.

### 6. Retire the multi-server client (independent — can land any time)

- `settings.ts` back to one `{url, token}`; migrate by keeping the active entry of
  `daedalus.servers`.
- Delete `sidebar/server-menu.tsx`, `ServersGroup` in `settings/general.tsx`, the palette's
  server rows (`command-palette/root-page.tsx`), profile "sync to server"
  (`settings/profiles.tsx` — backup/import covers moving a profile), `site-data.ts`'s
  per-server sweep, and `docs/plans/multi-server.md`.

### 7. Turns that survive a drop

The bridge runs detached (`bridge.mjs daemon`, a pidfile and a unix socket beside it) and
the link's remote command becomes `bridge.mjs attach`, which pipes stdio to the socket.
Events carry a sequence number and the daemon keeps what an absent server has not
acknowledged; a reattach resumes from the last one. A running turn keeps running through
a laptop's Wi-Fi dropping. The lifeline moves to an idle timeout (no link and no
children for 30 min → exit).

### Docs

`docs/architecture.md` gains "Hosts and the bridge"; `CLAUDE.md` gains the rules —
one seam, system ssh, never prompt, secrets inside the link, the bridge is one
dependency-free file identified by its hash.

## Out of scope

Password auth (keys and agent only); a Windows server reaching Linux hosts (path handling
is POSIX on both ends); Windows hosts; moving a project between hosts with its threads.

## Verification

- `server/test/bridge.test.ts`: spawn `bridge.mjs` locally over stdio (no ssh) and drive
  every op — handshake and hash, spawn/stdin/exit, exec with `input` and a timeout, the
  file ops with an escaping path, watch, and stdin EOF killing a child.
- An ssh host whose target is `localhost` (key in agent) drives `fake-echo`: create,
  prompt, kill the ControlMaster mid-turn → the next send revives via `session/load`.
- `pnpm exec tsc --noEmit` (server), `pnpm exec tsc -b` (client). UI is the user's check.

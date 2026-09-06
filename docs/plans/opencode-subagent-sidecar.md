# Plan: OpenCode subagent transcripts through an event sidecar

Status: **shipped** (steps 1–5). `server/src/opencode-subagents.ts`, `server/src/net.ts`,
`AgentDef.subagentFeed` (seed 16), `agentStream(proc, extra)`, `pnpm test:opencode-subagents`.
Deviations from the plan below: `PUT /api/agents/:id` does **not** accept `subagentFeed` —
it is declarative like `liveConfig`, and the route's schema deliberately excludes those; the
port comes from a pre-bound `PortPool` because `SessionManager.start` is synchronous. Step 6
(backfill on load) remains open.

## Problem

A thread on the `opencode` agent shows nothing of a subagent's work. The `task`
tool call arrives, and at the end its `<task id="…" state="…">` result (which
`client/src/lib/tools/subagents.ts` `parseTaskWrapper` unwraps), and that is all.
Everything the child did is invisible while it runs and afterwards.

The cause is a gate in OpenCode's own ACP bridge, not missing data. `opencode acp`
starts OpenCode's full HTTP server in-process (`Server.listen` in
`packages/opencode/src/cli/cmd/acp.ts`) and runs the ACP agent as an SDK client of
it. Its event translator (`packages/opencode/src/acp/event.ts`) does
`session.tryGet(sessionID)` on every `message.part.updated` / `message.part.delta`
and returns when the id is not a session ACP opened. Children are OpenCode
sessions of their own (`Session.parentID` set), so every one of their events is
dropped at that line.

`@ai-sdk/harness-opencode` (Vercel) gets past this by never using ACP: it
subscribes to the server's global `/event` SSE bus, seeds an allowlist with the
root session id, adds a child when the `task` tool part's metadata carries
`{parentSessionId, sessionId}` with a known parent, and routes every event by
session id. It then throws the child's transcript away and keeps only per-step
usage. We can do the same routing and keep the transcript, because the server
and client already have the tree (ACP subagent RFD path, `docs/protocol.md`
"Subagents").

Facts verified against OpenCode `dev` (1.18.x) and harness-opencode 1.0.100:

- `opencode acp --port <n> --hostname 127.0.0.1` exposes the HTTP API next to the
  stdio ACP transport. `OPENCODE_SERVER_PASSWORD` (+ optional
  `OPENCODE_SERVER_USERNAME`, default `opencode`) turns on HTTP Basic auth.
- The ACP session id **is** the OpenCode session id (`acp/service.ts` `newSession`
  does `session.create({ id: created.id })`).
- `GET /event` is the instance-wide SSE bus (`/global/event` is the multi-instance
  one). Events are `{ id?, type, properties }`; `session.created` carries
  `properties.info.parentID`; `session.status` carries `{sessionID, status}` with
  `status.type === "idle"` at the end of a turn; `message.part.updated` carries the
  whole part (`text`, `reasoning`, `tool`, `step-finish`, …); `message.part.delta`
  carries `{sessionID, messageID, partID, field, delta}`; `message.updated`
  carries `info.role`.
- The `task` tool writes `{parentSessionId, sessionId}` into its tool-part
  metadata (`tool/task.ts`), which the ACP bridge forwards as
  `rawOutput.metadata` on completion. `session.created` is earlier and simpler, so
  it is the primary discovery signal; the metadata is the fallback.
- A child's `permission.asked` is silently dropped by OpenCode's ACP bridge
  (`acp/permission.ts` `if (!session) return`). Our registry template sets
  `"permission":"allow"`, so no child ever asks. Documented, not solved here.
- `GET /session/{id}/children` and `GET /session/{id}/message` exist for backfill.
- Upstream PR sst/opencode#40654 (`acp-subagent-events`, "surface subagent
  activity") is still **open** as of 2026-09-02. The client already reads its
  `_meta["opencode/child-session"]` shape. If it merges, the sidecar is redundant
  and should be retired behind the `subagentFeed` flag (step 1).

## Design

One sidecar per spawned OpenCode process, on the server, feeding synthesized ACP
notifications into the bridge's stream. Nothing in `AcpBridge`, the journal, the
protocol or the client changes shape: a child's update travels as an `update`
event with `sessionId` set, exactly as a Codex RFD child does today.

```
opencode acp --port P  ──stdio (ACP)──▶ agentStream(proc) ──┐
        │                                                    ├─ merge ─▶ reroute ─▶ AcpBridge
        └──── GET /event (SSE) ──▶ OpencodeSubagentFeed ─────┘
```

`OpencodeSubagentFeed` (new `server/src/opencode-subagents.ts`):

1. **Subscribe.** `fetch("http://127.0.0.1:P/event")` with the per-spawn Basic
   credential, parsed as SSE, retried with backoff until the process exits (the
   server is up a beat after spawn; the ACP handshake is in flight at the same
   time). Aborted by the process's `close`.
2. **Allowlist.** `Set<string>` seeded lazily with the root id from a
   `rootSessionId(): string | null` callback (the bridge's `acpSessionId`, which
   `session/new` / `session/load` fills). `session.created` whose
   `info.parentID` is in the set adds `info.id`; so does a `task` tool part with
   `metadata.parentSessionId` in the set. `session.created` events seen before the
   root id is known are held in a small buffer and re-evaluated once it is. Any
   other session id is ignored. Nested children work by construction.
3. **Translate** the child's events into `SessionUpdate`s, addressed to the
   child's session id. Port the subset of `acp/event.ts` + `acp/tool.ts` we need,
   nothing more:
   - `message.updated` → remember `messageID → role`.
   - `message.part.updated` → remember `partID → {type, role}`; a `tool` part with
     status `running` → `tool_call` once (`toolCallId = callID`, `title`, `kind`
     via the same kind map OpenCode uses, `rawInput = state.input`); `completed` /
     `error` → `tool_call_update` with `status`, `content: [{type:"content",
     content:{type:"text", text: output|error}}]`, `rawOutput`; a `step-finish`
     part → `_daedalus/subagent_usage` with `tokens` mapped to `acp.Usage` and
     `cost` in `_meta.opencode`; `text`/`reasoning` parts on `updated` are ignored
     unless no delta was ever seen for that part (then emit the full text once,
     the "missing final delta" case harness-opencode handles).
   - `message.part.delta` on a known assistant `text` part → `agent_message_chunk`;
     on a `reasoning` part → `agent_thought_chunk`. Unknown part: drop (no
     `/message` fetch round-trip in v1; the `updated` always precedes the deltas
     on the same bus).
   - Ignore `file`, `snapshot`, `patch`, `agent`, `subtask` parts, and every
     `user` role part (the brief is on the parent's `task` row; the store drops a
     child's `user_message_chunk`s anyway).
4. **Lifecycle on the parent's session.** `subagent_spawned
   {subagentSessionId, name: info.title ?? "Subagent", task: <task prompt if the
   metadata fallback fired, else title>, capabilities: {}}` on discovery;
   `subagent_state_update {state:"completed"}` on the child's `session.status`
   idle (`"failed"` if the last tool part or a `session.error` for that id says
   so). Both are the RFD variants `agentStream`'s `reroute` already re-addresses to
   `_daedalus/subagent_update`, so they go through the merge **before** it.
5. **Emit** as `acp.AnyMessage` notifications
   (`{jsonrpc:"2.0", method:"session/update", params:{sessionId, update}}`) onto a
   `ReadableStream<acp.AnyMessage>`. `agentStream(proc, extra?)` merges it with
   the stdio readable ahead of `reroute`. The bridge's `onUpdate` sees a foreign
   `sessionId`, marks the event as a child's, and the journal, replay and client
   tree do the rest. The CLAUDE.md rule holds: nothing new listens on stdout.

Spawn side:

- `AgentDef` gains `subagentFeed?: "opencode-http" | null` (seed version bump,
  `backfill` sets it on the existing `opencode` row; `name/command/args/env` stay
  the user's). The seeded `opencode` row declares it.
- `spawnAgent` (in `acp-bridge.ts`) takes an optional `sidecar: {port, password}`;
  for a `subagentFeed` agent it appends `--port <port> --hostname 127.0.0.1` to
  the resolved args and sets `OPENCODE_SERVER_PASSWORD` in the env. The port comes
  from a shared `freePort()` (lift the copy in `ide.ts` / `dev-server.ts` into
  `server/src/net.ts`), the password from `randomBytes(24)`. Minted per spawn,
  never stored, like the gateway key. Registry `args` are not edited, so the
  probe (`probe.ts`, no thread) spawns without a port and without a feed.
- `SessionManager.spawn` (`sessions.ts` ~1276) builds the feed when the agent
  declares it, hands `feed.stream` to `agentStream`, and `feed.close()` on the
  process's `close` (which `retire` and `collapse` already reach through
  `proc.kill()`). No new field on `Session` is needed beyond the feed handle for
  the close call.

Not in v1, recorded so nobody rediscovers them:

- **Revive / `session/load`.** OpenCode replays the parent only; the journal is
  cleared by `respawnNow` before the load, so children vanish on revive. Phase 4
  backfills from `GET /session/{root}/children` + `/message` after `session/load`
  answers, replaying through the same translator with `historyReplay` semantics.
- **Child permissions.** Dropped by OpenCode itself; moot under
  `"permission":"allow"`. If a profile ever turns that off, the feed could answer
  `permission.asked` for allowlisted children over `POST /permission/{id}`, the
  way harness-opencode's `handlePermission` does. Out of scope.
- **The `task` row and the `subagent:<id>` item are siblings**, not nested, as
  they are for Codex RFD children today. Nesting the child under its `task` tool
  row would mean stamping `_meta.claudeCode.parentToolUseId`-style ownership,
  which `parentToolIdOf` reads first. Cheap to add once the `callID` ↔ child map
  exists (the metadata fallback gives it); decide after seeing it drawn.

## Steps

Each step typechecks (`cd server && pnpm exec tsc --noEmit`) and keeps
`pnpm test` green before the next.

1. **Registry flag.** `AgentDef.subagentFeed`, zod schema, seed bump with
   `backfill` for `opencode`, `registry.test.ts` case. `PUT /api/agents/:id`
   accepts it.
2. **Spawn plumbing.** `server/src/net.ts` `freePort()` (replace the two copies);
   `spawnAgent(…, sidecar?)`; `agentStream(proc, extra?)` merging a second
   readable ahead of `reroute`. Unit test in `acp-bridge-units.test.ts`: a
   notification pushed on `extra` reaches the bridge as an `update` event with
   `sessionId` set; an RFD variant on `extra` is re-addressed.
3. **The feed.** `server/src/opencode-subagents.ts`: SSE client, allowlist,
   translator, lifecycle, `close()`. Pure translator functions exported
   separately (`translateOpencodeEvent(state, event): Notification[]`) so the test
   needs no socket. New `server/test/opencode-subagents.test.ts` +
   `pnpm test:opencode-subagents`, added to `test`. Fixtures: a scripted event
   list (session.created with parentID, message.updated, part updated/delta for
   text, reasoning, a tool run to completion, step-finish, session.status idle)
   asserting the exact `SessionUpdate` sequence; a second fixture where the
   child's parts precede the root id being known; a third with an unrelated
   session that must produce nothing; a fourth exercising the `task` metadata
   fallback. One integration case spins a tiny `http.createServer` SSE endpoint
   and checks the fetch/retry/abort path.
4. **Wire it in** `SessionManager.spawn`: mint port+password, construct the feed
   with `rootSessionId: () => bridge.acpSessionId`, pass its stream, close on
   process `close`. Manual check against a real `opencode` thread that runs a
   `task`: child rows appear live under a `subagent:` item, usage lands, state
   closes on idle, nothing leaks after retire (`lsof -i :P` empty).
5. **Docs.** `docs/protocol.md` "Subagents": a fourth way a runtime says
   ownership, and why this one lives on the server. CLAUDE.md subagents bullet
   gets one clause. `docs/architecture.md` spawn section: the per-spawn port and
   password. Note PR #40654 as the retirement condition.
6. **(Later) Backfill on load** as described above, behind the same flag.

## Risks

- **Bus event shape drift.** `/event` is versioned loosely (harness-opencode's
  `unwrapOpenCodeEvent` handles a `sync` wrapper and both `properties`/`data`).
  Translator reads defensively and drops what it does not recognise; a shape
  change degrades to "no child rows", never to a broken parent.
- **Startup race.** The HTTP port is bound before the ACP loop starts (same
  process, `Server.listen` first), but the fetch may still beat it: retry with
  backoff, capped, and log once on give-up. A missed `session.created` is
  recovered by the `task` metadata fallback on the tool's completion.
- **Event volume.** Deltas for a chatty child are the same volume Claude Code
  already mirrors; the journal and `REPLAY_WINDOW_BYTES` cope by design.
- **Port exposure.** Loopback only, Basic auth with a per-spawn secret; the
  password rides in the child's env like `{apiKey}` does. Acceptable.

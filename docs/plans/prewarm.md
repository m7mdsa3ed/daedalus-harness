# Plan: prewarm a draft's agent process, hand it over at create

Status: **shipped** (steps 0-5, and 6 in part): `server/src/prewarm.ts` (the
registry: `specKeyFor`, `claim`, `drop`, `sweepPrewarm`, `prewarmEnabled`),
`server/src/routes/prewarm.ts` (`POST /api/prewarm`, `DELETE /api/prewarm/:id`, feature
`draftPrewarm` in `server/src/compat.ts`, wired in `index.ts`), the claim in
`SessionManager.start` (`takePrewarmed`, `server/src/sessions.ts:1749`) and the rowless gateway
answer (`setGatewayDraftResolver`, `server/src/gateway-shim.ts`); client side
`client/src/lib/prewarm.ts` (the 400 ms debounce), `prewarmDraft`/`cancelPrewarm`/`dropsSpawn` in
`client/src/lib/actions/draft.ts`, the composer's text-change trigger, and the cancels in
`dock.tsx`/`lifecycle.ts`. Tests: `server/test/prewarm.test.ts` (20, `pnpm test:prewarm`, in
`pnpm test`) and the draft-resolver cases in `test/gateway-shim.test.ts`.

Deviations from the plan below:

- **Step 0 was settled a third way.** Neither `p`-scoped spawn nor drafts inside `gatewayStateOf`:
  the process is spawned `s`-scoped on the draft id, and `setGatewayDraftResolver` is a *second*
  resolver the shim asks only after the manager said no. A real thread's provider answer still
  comes from the manager alone, so the kill rule the plan recommended is not needed for a profile
  change at all -- a stale process simply fails the spec comparison.
- **The claim is in `start`, not `create`** (`server/src/sessions.ts:2260`), because the spec is
  only final there: the model allowlist, the persona and its rules, and the model-calls door's
  env are all merged before it. `create` would have resolved a second copy that could disagree.
- **`Warm` holds neither `sessionId` nor `timer`** as the sketch had it: the registry is keyed by
  the draft id, and expiry is one minute-tick sweep beside `sweepIdle` rather than a timer per
  entry.
- **The cap is server-wide (`PREWARM_MAX` = 4), not per project** -- the open question, answered
  in the global direction.
- **`POST /api/prewarm` answers before `initialize`**, not after: `{ok}` means "a spawn was
  started". It also validates like create (a non-UUID id is a 400, a live session a 409) and
  resolves the agent from the profile, with create's wording for each refusal.
- **The client gates on `appMetaQuery`/`ensureQueryData`, not `useFeature`** -- an action cannot
  open a hook -- sharing the query key and fetcher with the hook.
- **A persona never reaches the warm spawn**, so a runtime whose `personaVia` is `env` fails the
  comparison and starts cold whenever the draft has a persona on it (`persona` is a `WarmRequest`
  field no route fills). The safe half of that bargain: codex loses the warming, never the right
  process.
- **The subagent mode is guessed, not known** (`harness` only where `AgentDef.requiredMcp` forces
  it): a thread that links `builtin:agents` by pick fails the comparison and spawns cold.
- **Step 6 is done**, in `CLAUDE.md` rather than `AGENT.md`: the two are separate files here,
  not the symlink the plan assumed, and `AGENT.md` is the stale copy. The rule, the `CHANGELOG.md`
  bullets and the line under `docs/protocol.md` "The client mints session ids" are all written.
- **A shared runtime warms the pool instead, and is never claimed** (`warmShared`). Caught in
  review, and it was the whole feature for Claude Code: `start` spawns a `sharedProcess` runtime
  through `AcpPool`, keyed on the spec with the thread's env *removed* (that env rides `_meta`
  per session), so a draft-keyed entry could never match — every Claude Code prewarm was a
  process spawned on the first keystroke and killed on send. Warming what `start` actually looks
  for is the fix; `probeShared` already does the same thing, so a draft whose options were
  probed is warm before this runs at all. `prewarm` now takes `shared`, read off
  `AgentDef.sharedProcess` by the route rather than inferred from the id.

## Problem

A thread starts as a draft (`docs/protocol.md` "The client mints session ids; threads start as
drafts"). `POST /api/sessions` is deliberately not called until the first message, so the first
send pays the whole cold start: `spawn`, `initialize`, `session/new`, and only then the prompt.
On this machine that is ~5 s for `initialize` alone on claude-agent-acp and 6-10 s more for
`session/new` (`HANDSHAKE_TIMEOUT_MS`'s own comment in `server/src/acp-bridge.ts`), most of it
spent with a message already written and the send button already pressed.

Two things already soften it, and neither covers the common case:

- **The options probe** (`server/src/probe.ts`) spawns an agent to ask what it can be configured
  with and kills it. It is cached per (profile, agent, cwd, allowlist) for
  `agentOptionsTtlHours`, so a cold menu is paid once.
- **Claude Code's shared process** (`AcpPool`, `IDLE_TTL_MS` = 5 min) is left warm by
  `probeShared`, so a draft's first message can start at `session/new` with `initialize` already
  answered — but only for a runtime whose `sharedProcess` is `acp-meta`, only within five
  minutes of that probe, and only when the probe ran at all.

Every other runtime — codex, opencode, the Daedalus agent — and every Claude Code draft whose
probe cache is warm but whose process is not, pays the full cold start on press.

## What this does not do

**It does not create the session early.** The draft's identity is local: no row, no journal, no
`session/new`, no prompt, no provider request, no token spent. Moving creation earlier would
undo the bargain in `docs/protocol.md`, and it is not needed — the expensive half is the process,
not the insert.

**It does not warm past `initialize`.** `session/new` is where model, effort (for a profile with
no catalog), persona, rules, modes, the MCP/skill/command union and the model allowlist are
placed. Warming past it would mean re-spawning on every config pick, which is exactly the cost
this is meant to avoid.

## Design

A prewarmed process is a spawned, `initialize`d `AcpConnection` that no thread owns yet, held in
a small registry keyed by the **draft id** and claimed by `sessions.create`. The handover is the
mechanism boot adoption already uses: `SessionManager.adopting` is a
`Map<sessionId, { conn, made }>`, read at `server/src/sessions.ts:2148` and consumed at
`server/src/sessions.ts:2193` as `adoptedBy?.conn ?? await pool.acquire(…)`. Prewarm writes the
same entry, so the second half of `start` — the bridge, the handshake, `session/new` — runs
exactly as it does today.

### The registry (`server/src/prewarm.ts`)

```ts
export interface Warm {
  conn: AcpConnection
  /** Everything that would make this process a different one — see below. */
  specKey: string
  sessionId: string      // the draft's id
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}
```

- Single-flight per draft id: two keystrokes do not start two processes.
- **Single use.** Claiming removes the entry. A respawn inside the same draft (a profile change
  before send) never finds it a second time.
- **The count is bounded, not just the age.** A client call to cancel cannot be trusted to
  arrive, so the cap is the real guarantee: at most `PREWARM_MAX` warm processes on the server,
  oldest evicted first. The TTL only stops one from sitting there forever.

### The spec key is the whole safety property

A warm process may only be claimed when the spawn it would have done is byte-identical to the one
it is. That is `resolveAgentSpawn` over the same inputs `start` would use — the agent id, the
profile, the cwd, model and effort (when the profile owns the catalog), the persona, the rules,
the helper models, the subagent mode — with `sessionId = draftId`. Anything that is env at spawn
is part of it.

The draft id is known before the row exists, and `gatewayUrlFor` already keys a thread-scoped URL
on `s`, so a process spawned for a draft gets the thread-shaped gateway URL it will still need
after the row appears. **This is the one piece that must be verified first** (§Order, step 0):
the child resolves that URL through `gatewayStateOf`, which reads `this.sessions` — and there is
no session yet. Two ways out, and step 0 picks between them:

1. **Spawn it profile-scoped** (`kind: "p"`, as the probe does) and accept that the process's
   gateway base URL is the profile's, not the thread's. The shim resolves a thread-scoped URL per
   request anyway, so a request arriving on `p` would not get the thread's live provider. This
   makes a profile switch mid-draft *not* fixable by staging — it must kill the warm process.
2. **Answer `p`-scoped reads for an id with no row** by registering the draft's pair in a
   `pending` map the resolver consults, so `s` works before the row. Cheap, but it puts a second
   source of truth in the one function that decides which provider a request bills to.

Recommendation: **1, with the kill rule stated loudly** — a profile change mid-draft kills the
warm process, and that is a pick that was already going to cost a spawn. Do not put drafts into
`gatewayStateOf`.

### What kills a warm process

| Change while typing | Kills | Why |
| --- | --- | --- |
| Profile | yes | base URL, credentials, header overrides are process env |
| Agent | yes | a different binary and a different spawn |
| Project / worktree / cwd | yes | cwd is in the spec and in the pool key |
| Model, effort | only when the profile owns the catalog | otherwise applied at `session/new`, then over ACP |
| Persona, rules | no | handshake `_meta` (`air-meta`) or `session/new` (`env`) |
| Mode, config options | no | applied post-`session/new` by `applyDraftMode`/`applyChoices` |
| MCP servers, skills, commands | no | read at `session/new` |
| The draft text | no | never reaches the process |
| `uiGroups`, `suggestKinds`, ask profiles | no | read at `session/new` |
| helper models | part of the spec | they are spawn env for a runtime that names roles |

The kill rule is implemented as: any draft-config change that is env-at-spawn calls
`drop(draftId)`; the route re-prewarms on the next keystroke. Nothing else does anything, because
the process never learned it.

### Lifecycle, and what happens to an abandoned one

- **Trigger**: the first keystroke in a draft with non-empty text, debounced ~400 ms. Not on page
  open — a New tab page is opened and abandoned far more often than it is typed in.
- **TTL 120 s**, refreshed by typing. The registry's sweep runs on the existing minute tick, next
  to `sweepIdle` (`server/src/sessions.ts:799`).
- **Client call**: `POST /api/prewarm { id, profileId, agentId, projectId, … }`. Rides only when
  the server advertises the feature (`FEATURES` in `server/src/compat.ts`, read with
  `useFeature`), so an older server is never asked.
- **Composer emptied, draft tab closed, draft deleted**: best-effort `DELETE /api/prewarm/:id`.
  Never trusted — the TTL is the guarantee, and this is only promptness.
- **Process exits on its own**: the entry goes with it, as `AcpPool.adopt`'s `forget` does.
- **Server restart**: the registry is in memory and dies with the process. A hosted host that
  outlives the restart is *not* adopted by boot adoption, because there is no row naming it —
  which is why **prewarm is gated off under `DAEDALUS_SANDBOX=hosted` in v1**. `direct` is the
  default, and a leftover direct child dies with its parent.
- **Claimed but create fails**: `start`'s existing `catch` retires the process and deletes the
  row (`server/src/sessions.ts:1837-1845`). A warm process is not special there.

### Failure is silent and costs nothing

If the prewarm request fails, times out (reuse `PROBE_TIMEOUT_MS`), or the agent is not
installed, the client records nothing and `create` spawns cold, exactly as today. The only
observable is the send being as slow as it always was. It never blocks a send and never surfaces
an error.

**A warm process is not a validated one.** `initialize` answering proves the binary runs, not that
the login, the profile credentials or the model work. Those still fail at `session/new` during
create, with today's error and today's Retry row.

## Cost

| Case | Today | With prewarm |
| --- | --- | --- |
| Claude Code, options cached, no live pool entry | cold spawn + `initialize` + `session/new` | `session/new` |
| Claude Code, probe just ran | already warm 5 min | no change |
| Codex, OpenCode, Daedalus agent | cold start, both halves | `session/new` |
| Draft typed in and then abandoned | nothing | one `initialize`, killed at TTL |
| Draft typed in and sent within 120 s of the TTL refreshing | cold start | one process, claimed |

The real cost is the abandoned case: an agent boot that nobody asked for, on a machine that may be
loaded. That is what the debounce, the TTL, the single-use rule and the per-project cap bound. It
is the same cost the options probe already pays, once per pair per TTL — this pays it per
abandoned draft instead, which is why the debounce and the per-project cap matter more than the
TTL does.

## Order of work

0. **Settle the gateway question.** Decide §The spec key between `p`-scoped spawn with a kill
   rule and answering `s` for a rowless id. Everything else is unaffected by the answer, but a
   wrong choice here is a billing bug, so it goes first and gets a test either way.
1. **`server/src/prewarm.ts`**: the registry, single-flight, TTL sweep, cap, `drop`. Unit-testable
   with a fake spawn, in the shape `test/probe.test.ts` already uses.
2. **The route** (`server/src/routes/prewarm.ts`), wired in `index.ts` beside the sessions
   routes, plus the `compat.ts` `FEATURES` entry.
3. **Claim at create**: the one lookup in `sessions.create`, writing into `this.adopting` the way
   `adopt-boot.ts:1050` does, and the spec-key comparison that decides whether an entry is
   claimable at all.
4. **Client**: the debounced trigger in `client/src/lib/actions/draft.ts`, the cancel on empty /
   close / delete, and the env-at-spawn kill list on `configureDraft`.
5. **Gate hosted off** (`DAEDALUS_SANDBOX=hosted`), and say so where the switch is documented.
6. **Docs and changelog**: a line in `docs/protocol.md` under "The client mints session ids" —
   the draft still creates nothing, only a process — and a rule line in `AGENT.md`/`CLAUDE.md`
   under Protocol and transport if it ships. `CHANGELOG.md` under `## [Unreleased]`.

## Checks

- `cd server && pnpm test` — the registry and the spec-key comparison get their own file, and
  `pnpm test:hidden`-style targeted runs while iterating.
- The claim path needs a test that a **stale** warm process is not used: warm on profile A, pick
  profile B, send — the agent must be spawned with B's env.
- Manual: cold Claude Code draft, type, wait for the preview log line, send, and read the
  `[spawn]` timing to confirm `initialize` was not re-sent.

## Open questions

- **Should the cap be per project or per server?** Per project matches the cwd that makes two
  drafts share a process; per server matches the machine's memory. Two per project on a machine
  with ten projects is twenty idle agents, which is probably too many — a global cap of four is
  probably the right first number, and it is a config value either way.
- **Does the AI runtime's own `initialize` do anything observable?** The Daedalus agent reads the
  repo's `AGENT.md`/`AGENTS.md`/`CLAUDE.md` on **every turn**, not at `initialize`, so a process
  warmed before an `AGENT.md` edit still reads the new one. That is a reason to keep warming; it
  is worth confirming nothing else in any runtime caches spawn-time text at `initialize` that a
  user can edit between the keystroke and the send.
- **Is `session/new` actually the remaining cost?** If the Daedalus agent's `session/new` is
  cheap, warming for it buys little, and the case for this feature is narrower than it looks.
  Measure before building.

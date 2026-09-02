# Git, backup & quota

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## Git repositories in a project

- **A project is a directory, and a directory is not one git repository.** It can hold
  several, or sit inside one, so `server/src/git.ts` addresses a `RepoContext` rather than
  "the project's git": a `dir` (always inside the project, and the cwd every invocation
  runs in — which is what scopes `add --all`, `reset` and `status` to what the panel
  listed), a `scope` (the repo-relative prefix of that dir, because porcelain v2 prints
  paths relative to the *worktree root* wherever git was run — stripped on the way out, so
  a project nested in a monorepo shows `index.ts` and never `packages/app/index.ts`, and
  needing no repair on the way back in since pathspecs are read from the cwd), and a `path`
  (where the repo sits in the project; `""` is the project itself, and the client joins it
  back on with `repoPath` before opening an editor). `repositories()` is a bounded
  breadth-first walk for `.git` that does not descend through a checkout it has already
  found — what is under one is that checkout's business. A subdirectory named as `repo` must be a worktree
  *root*: otherwise the enclosing repository would answer under a path prefix that is a
  lie, and staging one of those rows would stage a different file. `fileAt` is the one
  call with no `repo` at all — its `path` is project-relative and a file belongs to exactly
  one worktree, so the server derives it, and the editor's descriptor does not grow a
  second answer that can drift from the path beside it. The routes are still served; the
  only client left reading them is the editor panel's diff mode, since the source-control
  panel is gone.

## Turn changes and the review panel

- **A turn's footprint is measured by git, never read off the transcript.** The
  transcript knows the edits a *tool* declared; it does not know what a shell command did,
  and an agent that ran `sed`, a codemod or a script of its own changed the project just as
  much. So `server/src/turn-changes.ts` photographs the worktree as a tree object on the
  journaled `turn_started` and again on `turn_ended` (`git.snapshotTree`: the real index is
  copied to a scratch `GIT_INDEX_FILE` so git's stat cache carries over and only changed
  files are re-hashed, `add --all -- .`, `write-tree`; the real index is never touched, so
  the user's own staging and a terminal next door are unaffected). Both ids and the
  `--name-status`/`--numstat` summary land in `session_turn_changes` (cascading), and the
  summary rides the live-only `turn_changes` event so the footer chip can draw "3 files
  changed" without a git run per row.
- **Snapshots are off the prompt path, and the window is stated.** `turn_started` is emitted
  synchronously deep in the bridge and a queue drain starts the next turn in the same tick
  the last one ended, so both snapshots run on the next tick; a turn that ends before its
  start snapshot finished waits for it. The agent needs a model round-trip before it can
  touch a file, and a stat-cached snapshot takes milliseconds.
- **Scopes are tree pairs.** `turn:<id>` is the turn's two trees, or its start tree against
  a snapshot taken now while it is still running (or when the end snapshot failed);
  `uncommitted` is `HEAD` (the empty tree on an unborn branch) against a snapshot taken now —
  which is what makes untracked files appear, where `git diff HEAD` would not show them.
  Diffs are `--relative` to the project directory, so a project inside a larger checkout is
  measured at the project, the way `status` scopes itself. A tree git has pruned (they are
  dangling; the grace period is git's, a fortnight by default) reads as "unavailable", and so
  does a project that is not a repository — a sentence in the panel, never an error toast.
- **Writes are the project's git routes.** Stage/unstage/discard/commit act on the index and
  the worktree *as they are now*, whatever scope is being read: staging a file a turn touched
  stages the whole file. The one hunk-level door is `POST …/git/apply` (`git apply --cached`
  to stage a hunk, `--reverse` to discard one); git checks the preimage and refuses a hunk
  whose surroundings have moved on, with its own message. Routes:
  `GET /api/sessions/:id/changes` (every turn's summary), `…/changes/files?scope=`,
  `…/changes/patch?scope=&path=`. `pnpm test:fs` covers the tree helpers. The rows are not
  in a backup: the trees live in the repository, and a row without them is a summary that
  can no longer be opened.

## Backup & import

- **Backup is one JSON document, and import is one transaction.** `server/src/backup.ts`
  exports every user-data table in `db/schema.ts` (agents, profiles with their links,
  the library, projects, knowledge, previews, sessions with their links, queue,
  schedules, the event log, tasks, web-search usage, push tokens) plus config.json's
  `webSearch` block — never the server's token/host/port, the `agent_options` probe
  cache, or the `history_*` rows (meaningless without the snapshot files). Two opt-outs:
  `secrets=0` blanks profile keys, MCP header/env values and the search token, and
  `journals=0` leaves the transcripts out (the bulk of any install; a thread without one
  still revives through `session/load`). `GET /api/backup` downloads it;
  `POST /api/backup/import?mode=merge|replace` validates it against `BundleSchema` and
  writes it — `merge` upserts by id with a non-cascading `ON CONFLICT DO UPDATE` (an
  `INSERT OR REPLACE` would fire the cascades and take a profile's links with it),
  `replace` empties every table first. A thread's queue/schedules/log are replaced as a
  unit for every thread the bundle names (a merged log is two accounts stitched together);
  child rows whose parent exists nowhere are counted as `orphaned`, not fatal; a blank
  secret keeps the install's existing value, so a redacted bundle merged over its own
  install changes nothing. The route retires the threads it is about to rewrite first
  (`SessionManager.retireAll`) and `reload()`s the manager after — that is the same code
  the constructor runs at boot, and it leaves a live process untouched, rebuilds
  process-less rows (closing peers reading a changed archive), and drops rows that are
  gone. The client page is Settings › Backup (`components/settings/backup.tsx`): it reads
  the counts out of the chosen file locally, confirms, and hard-reloads after an import.
  `pnpm test:backup` round-trips it. The `agent_quota` cache is left out for the same
  reason the probe cache is — a percentage restored onto another machine describes an
  account that machine may not be logged into — but an agent's `quotaProbe` **is**
  carried, because a restored row keeps its `seededVersion` and would never be backfilled.

## Subscription quota (agent CLI)

- **Subscription quota is read by asking the runtime's own CLI, out of band.** ACP has no
  field for "how much of your plan is left", and the transcript's per-turn `Usage` is
  tokens, not windows — a plan's five-hour and weekly limits live on the *account*. So
  `server/src/quota.ts` runs what a person would: `claude -p "/usage" --output-format
  json` (that command is registered `supportsNonInteractive`, answers from local state
  with no API round trip, ~2.3s) and `codex app-server`'s JSON-RPC `account/read` +
  `account/rateLimits/read`. The command is **data on the agent** — `AgentDef.quotaProbe`,
  `{kind, command, args}`, seeded and backfilled like `spawnCategories`/`liveConfig` — so
  a user who repoints `command` can repoint this too; `kind` picks the adapter, because a
  CLI printing prose and a JSON-RPC server are not the same conversation. It names the
  plain CLI, never the ACP binary: the adapter is a session and a session is not what has
  an account. Two rules carry the design. **The snapshot is normalized (`QuotaSnapshot` in
  `protocol.ts`, so there is one copy of the shape) and the raw text is always kept** —
  one adapter parses prose, prose moves between releases, and a wording change has to
  degrade to "here is the report, unparsed" rather than to a card claiming 0%. And **"no
  quota" is an answer, not a failure**: an agent on a gateway or an API key has no
  windows, which is the common case here, so it reads `api-key` and the UI says so in
  words — never a zeroed bar, which is a different statement. (Verified: a codex on
  `auth_mode: apikey` answers `-32600 chatgpt authentication required to read rate
  limits`.) Codex's app-server is a *server*, so the probe kills it as soon as both
  answers land — waiting for it to exit cost the full 30s timeout for a reply that
  arrived in one. Readings are cached in `agent_quota` keyed `profileId:agentId` with a
  5-minute TTL — a quota moves on its own, so unlike the option probe this expires rather
  than being keyed by everything that could change it — coalesced by an in-flight map, and
  `?refresh=1` is the escape hatch. Errors are cached too: a missing binary re-spawned on
  every render is the one case where retrying hardest helps least. `SessionManager.refreshQuota`
  re-reads when a turn settles (the turn is what spent it) and fans out the live-only,
  absolute `quota` event — never journaled, or a replay would redraw last week's
  percentages as now — skipping child sessions and threads with no peer attached, and
  swallowing its own failure, since a missing `claude` must not surface as an error on a
  turn that succeeded. `GET /api/quota` is every probe-capable agent on its virtual
  Default profile (no credentials, so the agent runs on its own `claude`/`codex login` —
  which is what a subscription *is*); `GET /api/quota/:agentId?profileId=` is one pair.
  Settings › Usage (`components/settings/quota.tsx`) draws windows, not runtimes — a
  runtime metering three windows renders with no edit — with a profile selector, a Refresh
  and the raw report folded underneath; the composer's stats popover carries the same bars
  under the turn's own numbers (asked for once, on first open, then kept current by the
  event). **Settings › Usage is the only surface that lists plans.** The sidebar had a
  Usage row — a peak-percentage badge over `fetchAllQuota`, polled every ten minutes,
  hidden when nothing reported — and it is gone: it was the one nav row that *worked*
  rather than navigated, making the sidebar ask the server a question nobody had posed,
  on a timer, for a number whose only use is to send you to the page that shows it
  properly. The composer popover keeps its bars because they are about the turn you are
  in. `pnpm test:quota` pins both parsers against captured fixtures.

## Provider plan usage (profile)

- **The other plan is the provider's, and it is read from the profile — which outranks
  the agent's probe.** The rule above asks a *runtime's* CLI about the machine's own
  login, which is the right question for `claude`/`codex login` and nonsense for a
  gateway: a thread running Claude Code against a Z.AI GLM Coding Plan spends z.ai's
  five-hour and weekly windows, while `claude -p /usage` answers confidently about an
  Anthropic account that turn never touched. The account being spent belongs to the
  *credentials*, so the reader does too — `profiles.usage` (`ProfileUsage` in
  `db/schema.ts`: a `kind`, an optional host, an optional separate token), declared
  exactly the way `quotaProbe` is and dispatched to an adapter in
  `server/src/usage-api.ts`. Set, it wins in `runProbe`, and everything below the choice
  is shared — one `QuotaSnapshot`, one cache, one `quota` event — so nothing downstream
  knows which reader ran. **The adapter owns the endpoint**: `ProfileUsage` never carries
  a URL to fetch, a header name or a response path, because these are the routes a
  provider's own dashboard calls rather than ones it documents (z.ai's wants the key in a
  bare `Authorization` with *no* `Bearer`, and buries its windows under integer unit
  codes — `unit:3, number:5` is the rolling five hours, `unit:6, number:1` the week);
  expressing that as configuration would make the profile form a small programming
  language and the next provider still would not fit it. An unknown `kind` therefore
  throws rather than falling through to whichever adapter is the default branch, which is
  the one thing the agent-side `runProbe` still does. Two consequences worth stating.
  **The cache key changes shape**: a probe's answer is the (profile, agent) pair's, a
  provider's is the *profile's* alone — one account whatever runtime spends it — so it
  keys `<profileId>:usage` and Claude Code and Codex on the same plan share one reading
  instead of making the same call twice and drawing two cards. `invalidateQuota` takes
  the profile rather than its id for exactly that reason, and `updateProfile` now drops
  every `agent_quota` row under the profile (the TTL covers a number that moved; it does
  not cover a number that is now about a different account). And the reading has a
  `source` (`"agent" | "profile"`, absent on rows journaled before this existed, which
  were all agents'): `GET /api/quota` lists provider plans *first* and then the
  probe-capable agents, `GET /api/quota/profile/:profileId` is one plan on its own, and
  Settings › Usage picks `ProfileQuotaCard` or `AgentQuotaCard` on it — same
  `QuotaBody` underneath, no agent selector on the provider one because there is no
  agent. Configured in the profile form's "Plan usage" section, where the token follows
  the same write-only bargain as `apiKey` (a boolean comes back; empty on save keeps the
  stored one) and empty means "use the profile's own key", which is the ordinary case.
  The built-in adapters, and adding one is `USAGE_KINDS`, a branch in
  `readProfileUsage`, a label in `USAGE_PROVIDERS` and a fold test in `pnpm test:quota`:
  - `zai` — `GET {host}/api/monitor/usage/quota/limit`, bare `Authorization`, host
    inferred from the profile's own base URL so a `bigmodel.cn` gateway reads the CN
    platform. Undocumented (the Plan Overview page's route).
  - `minimax` — `GET {host}/v1/token_plan/remains`, bearer; every model carries its own
    5-hour and weekly request counters and the fullest one is the plan's reading. A
    bad key is HTTP 200 with `base_resp.status_code: 1004`. Undocumented; host from the
    base URL (`minimaxi.com` is the CN platform).
  - `kimi` — `GET {host}/coding/v1/usages`, bearer, counts as strings; `usage` is the
    weekly allowance and `limits[]` the rolling windows (`TIME_UNIT_HOUR × 5`). Host
    taken from a base URL that names `/coding`, else api.kimi.com.
  - `synthetic` — `GET https://api.synthetic.new/v2/quotas`, bearer; one object per
    pool (`subscription`, `search`), read as any top-level object with a `limit` and a
    `requests`/`used` count, so a pool added later is a labelled window with no duration.
  - `deepseek` — `GET https://api.deepseek.com/user/balance`, documented; pay-as-you-go,
    so the reading is `credits` on an `api-key` status and never a window.
  - `openrouter` — `GET /api/v1/key` and `/api/v1/credits`, documented; a key with a
    `limit` is a window over its `limit_reset`, the credits line is the account's.
    `/credits` failing is folded as "no credits line", not as the reading's failure.
  Two that were checked and deliberately not added: Alibaba's coding-plan quota (the
  console's `queryCodingPlanInstanceInfoV2` route answers `ConsoleNeedLogin` to a bare
  API key — it needs a browser session the harness will not hold) and Chutes (no pinned
  response shape). Their presets carry endpoints only.

## Profile presets

- **A preset is a starting point, never a stored kind** (`server/src/profile-presets.ts`,
  `GET /api/profile-presets`). A coding plan is a provider with everything already
  decided — the Anthropic-shaped path for Claude Code, the OpenAI-shaped one for the
  rest, the plan's own (shorter) model list, and which usage reader reports it — and
  typing that by hand is where a z.ai key ends up on `/api/paas/v4` instead of
  `/api/coding/paas/v4`, billing the pay-as-you-go balance and reading back "no plan".
  Picking one on the new-profile form copies those fields in; what gets saved is an
  ordinary profile with no preset id on it, so a preset the harness later changes never
  rewrites a saved profile and nothing has a "detached" state. **Models come from
  models.dev, not from the preset**: each names the models.dev provider that *is* the
  plan (`zai-coding-plan`, not `zai`) and the route fills `models` through the same
  `searchModelsDev`/`toCandidate` the editor's "Fill from models.dev" uses; a dead
  models.dev answers `modelsUnavailable: true` with the URLs intact rather than failing
  the list. The route also drops agents this install does not register, so the form
  cannot save a link to a runtime that is not here. Codex is on a preset only when the
  plan serves the Responses API — the shim forwards it, it does not translate it.

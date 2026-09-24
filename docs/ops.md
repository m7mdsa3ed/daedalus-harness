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
  second answer that can drift from the path beside it. The clients are the IDE's source-control
  view (`scm-view.tsx`, the status and the writes) and its diff tab (`diff-tab.tsx`, which
  reads one side through `fileAt`).

## A thread's own worktree

- **Isolation is picked on the draft and made before the thread exists.** "Isolate in a git
  worktree" (the draft scope row's `WorktreeChip`, offered when `git/repos` has a root entry)
  rides `POST /api/sessions {worktree:true}`; `SessionManager.create` calls
  `git.createWorktree` first — `git worktree add .daedalus/worktrees/<short-id> -b
  daedalus/<short-id>` in the project directory — so a refusal (not a repository, not its
  root, an unborn branch) is a failed create in git's own words with no half-made thread.
  **`.daedalus/` is ignored through `$(git rev-parse --git-common-dir)/info/exclude`, never the
  user's `.gitignore`**, which is what keeps the project's own status and every turn snapshot
  from seeing the checkout. Only a project that *is* its repository's root may isolate: nested
  in a larger checkout, the thread's turn paths and source control's would be measured from
  two different roots.
- **`sessions.worktree` is project-relative and never moves.** The agent names its
  conversation by the cwd it ran in, so a thread that changed directory would lose it. Every
  place that asks where the thread runs goes through `threadCwd(session, project)` — the
  spawn, the bridge's `session/new` cwd, the model allowlist, the turn snapshots (`cwdOf`),
  the `!` shell route — and **materialisation unions per *thread* cwd**, so a worktree's
  skills and commands are written into the worktree and swept against only the threads in it.
  A fork shares its parent's worktree and a workflow step works in its parent's.
- **Source control reaches it as a `repo`.** The worktree lives inside the project, so every
  file and git route already addresses it by project-relative path; the inspector's Changes
  tab joins `meta.worktree.path` onto every thread-relative path it opens and names it as the
  diff's `repo` (the walk never finds it, since it does not descend through the project's own
  checkout, nor into dot-directories).
- **Archiving leaves the worktree; removing it is its own door** (`DELETE
  /api/sessions/:id/worktree`, "Remove worktree" in the thread and Trash menus). It refuses a
  running turn, and uncommitted work unless `?force=1` — the 409 names the files, and the
  client asks again with that text. The branch is kept (its commits are the work) and so is
  the column: a revive into a directory that is gone fails on it rather than moving the agent
  elsewhere. `list()` reports `exists` only for a thread whose project it has resolved since
  boot. `pnpm test:worktree` covers create, the exclude line, the refusals and removal.

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
  `thread` is the thread's first measured turn's start tree against now; `branch` is the
  merge-base of HEAD with the default branch (`origin/HEAD` when the remote names one, else a
  local `main` or `master`) against now — "unavailable" when there is no such branch or HEAD
  is it (`git.branchBase`).
  Diffs are `--relative` to the project directory, so a project inside a larger checkout is
  measured at the project, the way `status` scopes itself. A tree git has pruned (they are
  dangling; the grace period is git's, a fortnight by default) reads as "unavailable", and so
  does a project that is not a repository — a sentence in the panel, never an error toast.
- **Reverting a turn is a working-tree write of exactly that turn's paths**
  (`git.revertTurn`, `POST /api/sessions/:id/turn-changes/:turnId/revert {force?}`). The
  paths are the turn's start ↔ end diff with renames split into their two halves; each goes
  back to the start tree — rewritten, recreated, or deleted if the turn created it — through
  `checkout-index` out of a scratch index holding the start tree, so **the real index is
  never touched** and neither is any other path. **It refuses when one of those paths
  differs between the turn's end tree and a snapshot now** — a later turn, the user, an
  editor — answering 409 `{error, conflicts}` with nothing written, and `force` reverts over
  them. The session refuses while a turn runs, since the agent could be writing the same
  files. `pnpm test:turn-revert` covers modified/created/deleted paths, the index, the
  refusal, force and `branchBase`. A rewind's file half now restores into a worktree
  thread's own checkout (`repo: session.worktree`) rather than the project's.
- **Writes are the project's git routes.** Stage/unstage/discard/commit act on the index and
  the worktree *as they are now*, whatever scope is being read: staging a file a turn touched
  stages the whole file. The one hunk-level door is `POST …/git/apply` (`git apply --cached`
  to stage a hunk, `--reverse` to discard one); git checks the preimage and refuses a hunk
  whose surroundings have moved on, with its own message. Routes:
  `GET /api/sessions/:id/changes` (every turn's summary), `…/changes/files?scope=`,
  `…/changes/patch?scope=&path=`, `…/changes/file?scope=&path=&side=` (scope `turn:<id>`,
  `thread`, `uncommitted` or `branch`). `pnpm test:fs` covers the tree helpers. The rows are not
  in a backup: the trees live in the repository, and a row without them is a summary that
  can no longer be opened.

## Backup & import

- **Backup is one JSON document, and import is one transaction.** `server/src/backup.ts`
  exports every user-data table in `db/schema.ts` (agents, profiles with their links,
  the library, projects, knowledge, sessions with their links, queue,
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
  - `9router` — a **self-hosted gateway**, and the one adapter whose reading is
    not one plan: 9Router fronts many accounts (a Claude subscription, a Codex
    login, a GLM key, a free tier) and falls back between them. **So every account is its own
    plan, and a window says which it belongs to** (`QuotaWindow.group`): the card
    draws a section per account — name, its fullest window beside it, its own
    tiles under it — which is the shape the sidebar popover already drew two
    accounts of one provider in. Pooling across the accounts was tried first, on
    the theory that fallback makes the gateway's aggregate the only number that
    gates a turn, and it is wrong for what a person does with this page: a
    five-hour window is a *different* five hours per account, a Max subscription
    and a GLM key are not interchangeable capacity, and "60% across four
    accounts" hides both the exhausted account and the untouched one. **The
    accounts stay in the gateway's own priority order** — the order it will spend
    them in, so the first section is the one serving now and sorting by fullness
    would scramble the one fact a fallback chain has to show. Two accounts the
    gateway gives the same name are disambiguated (`Claude`, `Claude (2)`), on
    the name as well as the group string, because a heading has no second line
    for the group to hide in.
    **Every account the gateway holds is named, in `QuotaSnapshot.accounts`, not
    only the ones that answered.** The list is read from the gateway's own
    connection route before any quota is asked for, so an account that has been
    turned off, or whose credential no longer answers, is still a section — with
    no bars and its own state in words, the gateway's message where it left one
    (`Kiro quota API rejected the current token.`) and a stand-in where it did
    not. A page that lists only the accounts that reported is a page that never
    says the silent one exists. Only a *turned-off* account is not asked at all:
    the call would disagree with the gateway's own reading of its rotation.
    `GET /api/providers/client?accountStatus=all&sort=priority` (already filtered
    to the connections it can report on, which is why it and not
    `/api/providers`) then `GET /api/usage/:connectionId` per *active* row,
    capped at 40 so one refresh cannot become hundreds of upstream calls; the cap
    is this adapter's, so the accounts past it are counted as `+n not shown` off
    the gateway's own `pagination.total` rather than as "not reporting". The plan
    name counts the rest (`9Router · 4 accounts (1 off, 2 not reporting)`).
    Host from the profile's own base URL's origin — it is the same server as
    `…:20128/v1`. **Its `sk-` key is not the credential**: that authorizes `/v1`
    inference only, while every `/api/*` route sits behind the dashboard session,
    so the call is made bare (the whole answer with `requireLogin` off) and, on a
    401, retried after a `POST /api/auth/login` with the dashboard password —
    which is what `ProfileUsage.apiKey` holds here. A 401 with no password says
    so in words. One account failing is that account's row, never the reading's.
    **A window is named the way the gateway's own dashboard names it, not the
    way its handler keyed it**: `/api/usage/:id` is a raw body 9Router runs
    through one provider-aware normalizer before drawing (`parseQuotaData` in
    `ProviderLimits/utils.js`), and reading it without that is how the same
    account said `spark_weekly` here and "Spark (Weekly)" there. Ported, and only
    where it differs from the raw body: Codex's window names, Qoder's
    `user`/`organization` names and its skipped empty bucket, and Antigravity's
    dozen model rows collapsed to one bar per family at the family's **worst**
    window (the model that runs out first is what gates the account). The
    percentage is the gateway's own rule, extended the one way it had to be:
    `remainingPercentage`, else a `remaining` that is the same kind of number as
    `total` read as an absolute remainder (Kiro, Qoder) and a `total: 100` pair
    read as a percentage, else the pair. A window marked `unlimited` is **kept**,
    carrying `QuotaWindow.unlimited` — a spend against no stated budget is a real
    reading (Vercel's `Used (USD)`), and dropping it is how a pay-as-you-go
    account read as having no windows at all; the renderer draws the figure and
    no track, because a bar at 0% and "there is no ceiling" are different
    statements. Nothing in the client knows what a group *is*: `WindowGrid` draws
    the reading's accounts, each joined to its own bars through `group`, an
    ungrouped reading is the flat grid it always was, and the flat surfaces (the
    composer popover, the sidebar) draw the same accounts under their own names.
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

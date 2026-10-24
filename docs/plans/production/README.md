# Production readiness

Audit of 2026-10-24, split into one plan per phase. Each phase file is self-contained: its
context, its steps and its done-when.

## Where things stand

- **The build is healthy, the edges are not.** `tsc` passes in all three packages, the client
  production build passes, agent suites 15/15, server suites 58/59. What fails is the door
  (auth), the data (schema push with no backup, no scheduled backup) and the hygiene around them
  (logs, permissions, CI).
- **Scope: single owner.** One bearer token, one tenant. Multi-user (accounts, per-user data)
  is a feature, not a fix, and is out of scope.
- **The token is the owner's choice.** No phase generates, lengthens or rejects it.
- **The backup belongs to the deploy.** It runs inside `db:push`, so every deploy and every
  hand-run push takes one first.

## Phases

| # | Plan | Size | Blocks |
|---|---|---|---|
| 1 | [Lock down access](01-access.md) | hours | exposing the server at all |
| 2 | [Backups and schema safety](02-backup-and-schema.md) | a day | the next deploy |
| 3 | [Commit and gate](03-commit-and-ci.md) | a day | phases 4-6 landing safely |
| 4 | [Operations](04-operations.md) | days | running unattended |
| 5 | [Hardening](05-hardening.md) | days | prompt-injection resistance |
| 6 | [Completeness](06-completeness.md) | days | handing it to anyone else |

## Order

- 1 and 2 first, in either order; neither depends on the other.
- 3 before anything in 4-6 lands, so CI gates the rest.
- 4-6 in any order after that. Among them, phase 5 items 1-3 (`/api/sql`, loopback keys, agent
  tools) come first, because each one turns a prompt-injected agent into admin access.

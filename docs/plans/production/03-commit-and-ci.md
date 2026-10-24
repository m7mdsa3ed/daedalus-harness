# Phase 3: commit and gate

## Context

- **The index is half staged.** It stages the deletion of the old workflow files
  (`server/src/workflows.ts`, `workflow-mcp.ts`, `workflow-saved.ts`, `workflow-schema.ts`,
  `workflow-script.ts`, `routes/workflows.ts`, two tests) while their replacements are untracked:
  `server/src/workflows/`, `model-calls/`, `mentions/`, `thread-mcp.ts`, `routes/mentions.ts`,
  `agent/src/trace.ts`, ~20 client files and 16 tests. `tsc` passes only because the working tree
  has everything; a partial commit does not build.
- **Two gates fail on the working tree.**
  - `openui:check`: `Cannot find package '@daedalus/tps'`. The esbuild call in
    `client/scripts/gen-openui.mjs:140` knows only the `@` alias, and the new
    `lib/mentions/` import chain reaches `lib/store/reducer.ts`. The prompt itself has not
    drifted.
  - `test:native-workflow-rows`: `Cannot find package '@/lib'`. `client/src/lib/tool-batches.ts:21`
    gained a value import from `@/lib/tools`, which the server's tsx cannot resolve. It also
    stops `agent pnpm test` and the server's `&&` chain early.
- **There is no CI**, no pre-commit hook, and eslint crashes (typescript-eslint vs TS 7).

## Steps

1. **Commit the in-flight work whole**: `git add -A` across `server/src`, `server/test`,
   `agent`, `client/src`, `docs`, with the changelog lines it carries, including one for the
   Anthropic protocol (`DAEDALUS_AGENT_PROTOCOL`). Check from a clean clone with the three `tsc`
   runs.
2. **Fix `openui:check`**: add the vite aliases (`@daedalus/tps`, `@daedalus/delivery`,
   `@daedalus/compat`, from `client/vite.config.ts:183`) to the esbuild call.
3. **Fix `test:native-workflow-rows`**: make the import in `tool-batches.ts` relative, or give
   the test the client's path mapping.
4. **CI** (`.github/workflows/ci.yml`):
   - `tsc` in client, server, agent.
   - `agent pnpm test`.
   - `server pnpm test` against a Postgres 18 service container.
   - `client vite build`.
   - `openui:check`.
   - `pnpm audit --prod` as a report, not a gate.
5. **`engines`** (Node 22, pnpm 10) in all four manifests; `build:agent` uses
   `pnpm install --frozen-lockfile`.
6. **Wire the client checks**: a `test:checks` script that runs the 20 `src/**/*.check.mjs` and
   fails on a non-zero exit; add it to CI.

## Done when

- `git status` is clean after the commit, and a fresh clone builds.
- CI is green on that commit.

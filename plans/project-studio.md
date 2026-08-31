# Daedalus Harness — Project Studio (start a project from a template)

## Context

A project in this harness is a *row*, not a place it made. `createProject`
(`server/src/projects.ts:40`) records a `name`, a `cwd`, a description and a
logo, and **never creates the directory**. Every project that exists was made
by hand somewhere else — mkdir, clone a starter, install, come back and type
the path into Settings › Projects — and then the first turn of the first thread
is spent re-explaining a stack the last five projects also had.

The Studio is the missing front door: a gallery of **git-repo templates**, each
a pre-configured starting point with a kit (MCP servers, skills, commands) and
a setup instruction attached. Picking one creates the directory, records the
project, and opens a thread whose composer is already prefilled with that
instruction — which the **agent** carries out in its first turn (`git clone`,
install, report). The harness runs nothing itself and executes no scaffold.

**Generic, not design-specific.** Templates are for any kind of project; the
seeded set starts with Node/TypeScript, and Python/Go/anything else later is a
*data* change with no code branch. `runtime` is a free-text label the gallery
groups by, never something the server switches on.

### What the market calls a "design studio", and which half this is

Two unrelated features ship under that name, and this plan is the second one.

- **Visual editing on the running app** — [Cursor Design Mode](https://cursor.com/docs/agent/design-mode)
  (select DOM nodes in the browser panel; the agent gets xpath + component +
  computed styles + props *and* a screenshot), [Lovable Visual Edits](https://lovable.dev/blog/introducing-visual-edits),
  [v0 Design Mode](https://v0.app/docs/design-mode), [Onlook](https://github.com/onlook-dev/onlook)
  (`data-oid` stamped at build time, drag/resize writes back to `.tsx`).
  Universal shape: select element → panel emits Tailwind classes → NL escape
  hatch. **Out of scope**, and expensively so: `web-panel.tsx` sandboxes its
  iframe *without* `allow-same-origin` on purpose, so the app cannot read the
  previewed DOM at all. Reaching it needs a same-origin preview proxy (the
  `/ide/<key>/` pattern again) plus an injected picker script — a whole feature,
  not a section of this one.
- **Starting from something instead of nothing** — [Lovable's projects flow](https://docs.lovable.dev/features/projects/overview):
  the `+` menu offers "start from a template" (and, separately, "apply a design
  system"), and *remixing* a template is how a project begins. Superdesign's
  variant canvas and Claude's own design-system pane are neighbours of the same
  idea. **This is the half we want**, minus the design-system part —
  `theme-builder.tsx` / `custom-themes.ts` already hold most of that and it is a
  different plan.

### What the harness already has

Mostly composition. One new table, one new page, one genuinely new capability.

| The piece | The harness's equivalent | State |
|---|---|---|
| Reusable rows the user CRUDs | `library.ts` (`commands`/`skills` objects) + the generic route loop in `routes/library.ts:16` | exists |
| Built-ins that reach installs added later | `DEFAULT_AGENTS` + `seedAgents()` (`registry.ts:435`), `introduced`/`since`/`backfill` | exists |
| A kit attached to a thing | `db/links.ts` descriptors + `profile_*`/`session_*` join tables | exists |
| Passing a kit to a new thread | `POST /api/sessions` already takes `mcpServerIds`/`skillIds`/`commandIds` (`routes/sessions.ts:29`) | exists |
| A thread that exists before the server knows | drafts — `actions.newDraftThread` returns the id, nothing is created until the first message | exists |
| Prefilling a composer | `saveDraft(sessionId, text)` (`lib/drafts.ts:57`) | exists |
| Picking a directory on the server | `PathInput` (`ui/suggesting-input.tsx:203`) over `GET /api/fs/list` | exists |
| A page that is a place, not a form | `components/project-page.tsx`, `/projects/:id` | exists |
| Remembering how the last thread was configured | `lib/thread-defaults.ts` | exists |
| Running the clone and the install | the **agent**, through its ordinary shell tools | exists |
| Templates as data | — | **missing** |
| Creating a directory the harness does not yet own | — | **missing, and the only new power** |

### The crux: one `mkdir`, and it is outside every project root

Everything `workspace-fs.ts` does is anchored to `projectRoot(projectId)`
(`workspace-fs.ts:125`) and checked for containment — lexically and then against
the real path — because every path it touches is user input naming a file *for
an agent to open*. Creating a new project's directory has no such anchor: there
is no project yet, and the parent is wherever the user keeps their code.

So this is deliberately the **only** write outside a project root, it happens in
exactly one function, and it creates an **empty directory and nothing else**.
Every file that ends up in it is written by the agent in a normal turn, in its
own cwd, under the permission rules that already govern that. The harness never
becomes a second writer to a user's repo.

The substitute for containment is a short, stated rule:

- the parent must be an **absolute** path that already exists and is a directory;
- the target must not exist, or must exist and be **empty** (so a re-try after a
  failed first turn is not an error, and an occupied directory is never
  clobbered);
- no symlink traversal — resolve and re-check, as `resolveInProject` does;
- failures are `WorkspaceError` (`workspace-fs.ts:44`), so the existing status
  mapping and the client's `ApiError`/`describeError` path carry them unchanged;
- if recording the project row then fails, the directory it just made is removed
  — and only if it made it.

## Design

### What a template is

One new table, `project_templates`, in `server/src/db/schema.ts`:

| column | meaning |
|---|---|
| `id`, `name`, `description`, `logo_url` | the card |
| `repo_url`, `repo_ref`, `repo_subdir` | the starter; ref and subdir nullable |
| `runtime` | free text — `"node"`, later `"python"`. A label, never a branch. |
| `tags` | JSON `string[]`; what the gallery filters on |
| `setup` | markdown: install command, env file, dev command — what the agent must do after cloning |
| `prompt` | the body handed to the composer |
| `seeded_version` | built-in provenance, exactly like `agents.seeded_version` |
| `created_at` | |

Plus three join tables — `template_mcp_servers`, `template_skills`,
`template_commands` — `ON DELETE CASCADE` both ways and read/written through the
existing descriptor helpers in `server/src/db/links.ts`
(`readLinks`/`writeLinks`), exactly as `profile_*` and `session_*` are. This is
the "pre-configured" half that matters as much as the repo: a template says
*and it comes with these tools*, and those ids are handed straight to
`POST /api/sessions`, which already accepts them. A stale id links nothing and
nothing filters, per the standing rule.

`setup` and `prompt` accept `{name}`, `{cwd}`, `{repo}`, `{ref}`, `{subdir}`,
rendered by **one** function, server-side, so the client cannot drift from it.

### Built-ins

`BUILTIN_TEMPLATES` carries `since` / `introduced` / optional `backfill` and
`seedTemplates()` implements the same rule as `seedAgents()`
(`registry.ts:435`) — including the part that is easy to get wrong: `introduced
<= applied` means a missing row was **deleted on purpose**, not owed to a fresh
install, which is why the two versions have to be separate fields. Built-ins are
ordinary rows: editable, deletable, and never overwritten on the fields a user
may have changed.

Seed small and honest — a plain TypeScript service and a Vite + React + Tailwind
app to start. Adding a Python or Go template later is an entry in this array.

### The flow

1. **Studio gallery** (`/studio`) — cards, filtered by tag/runtime.
2. **Use this template** → a dialog: project name, parent directory
   (`PathInput`), folder name defaulted to a slug of the name and editable,
   and profile/agent pickers resolved through `lib/thread-defaults.ts` so a
   Studio thread starts configured like any other.
3. `POST /api/projects/from-template` → `{ project, prompt, links }`.
   Server side: validate, `mkdir`, `createProject`, render the prompt.
4. Client: `actions.refreshProjects()` → `actions.newDraftThread({ project,
   profile, agentId })` (returns the draft id) → `saveDraft(id, prompt)` →
   navigate to `threadPath(id)`.
5. **Nothing is sent.** The draft model already means no session row and no
   agent process exist until the first message, so the composer opens prefilled
   and editable — you can add "…and make it a CLI, not a server" before anything
   runs. The template's links ride the composer strip's existing thread picks
   into `POST /api/sessions` when you do send.
6. The agent clones, installs and reports. **The transcript is the progress
   view** — there is no scaffold UI of our own to build, and a failure is
   readable in the place failures already are.

## Phases

### Phase 1 — Schema + server module

- `project_templates` + the three join tables in `db/schema.ts`; export from
  `db/index.ts`; `pnpm db:push` (no migration files — the standing rule).
- `server/src/templates.ts`: `TemplateInputSchema`, a `templates` CRUD object
  shaped like `library.ts`'s `commands`/`skills`, link read/write through
  `db/links.ts`, `BUILTIN_TEMPLATES` + `seedTemplates()`, `renderPrompt()`, and
  `createFromTemplate()` with the directory rule above.
- Call `seedTemplates()` beside `seedAgents()` at `server/src/index.ts:43`.

### Phase 2 — HTTP surface

- `GET/POST/PUT/DELETE /api/templates` — the loop in `routes/library.ts:16`
  takes a fourth entry, or a sibling loop if the link handling makes it awkward.
- `POST /api/projects/from-template` in `routes/workspace.ts`, where the project
  routes already live.
- `server/src/backup.ts`: add the table and its links to the bundle and to
  `BundleSchema`. **A table the bundle does not know is a table a restore
  silently drops**, and templates are user data.

### Phase 3 — Client

- `lib/templates.ts` — the `Template` type and the calls, shaped like
  `lib/workspace/previews.ts`.
- `components/studio-page.tsx` — the gallery, built like `project-page.tsx`:
  header, tag/runtime filter, a card per template (mark via `EntityIcon`, name,
  description, repo host, tags, the kit it brings), each with **Use this
  template**; a create dialog as described.
- Reaching it: a `SidebarNav` row (`thread-sidebar.tsx:104`, same `ROW`/`MENU`
  scale as its siblings), a command-palette entry, and a link from the empty
  state in `settings/projects.tsx` — which is exactly where someone with no
  projects is standing.
- `studioPath()` in `lib/router.tsx`; the route in `app-shell.tsx` beside
  `/projects/:projectId`.

### Phase 4 — Settings › Templates

- A section in `components/settings/sections.ts` and
  `components/settings/templates.tsx` (list + form), modelled on
  `settings/commands.tsx` — the closest existing form (name / description /
  long text body) — with the library pickers for the kit.
- Routes `templates` and `templates/:entryId` in the settings block of
  `app-shell.tsx`.

## Non-goals

- **No visual editing.** No element picker, no preview proxy, no property panel.
  The sandbox in `web-panel.tsx` stays as it is.
- **No design-system half.** No tokens written into the new project, no style
  guide generation. `theme-builder.tsx` is untouched.
- **No scaffold executor.** The harness does not run `git`, does not run a
  package manager, and does not stream a job. If that is ever wanted, the
  existing PTYs (`terminals.ts`) are the place, not a second execution system.
- **No template marketplace**, no remote index, no sharing. A template is a row
  in this install's database; `backup.ts` is how it travels.
- **No writes into an existing project.** A template only ever fills a directory
  the Studio just created empty.

## Open questions

- Should a template be able to carry **`configChoices`** (model/effort/mode) the
  way a draft does, or is inheriting `thread-defaults` enough? Leaning enough:
  a template is a stack, not a way of working, which is the same line the
  profile/agent split already draws.
- Should the created project get a **saved preview** (`previews.ts`) for the
  template's dev URL up front, or should the agent be told to report the URL and
  the user save it from the Browser panel? Leaning the latter — the port is not
  knowable before the first run, and a saved preview pointing nowhere is worse
  than none.

## Verification

1. `cd server && pnpm db:push` — the schema change.
2. `cd server && pnpm exec tsc --noEmit && pnpm test && pnpm test:backup` — the
   last round-trips the new table and its links through export/import.
3. `cd client && pnpm exec tsc -b`.
4. End to end with `cd server && pnpm dev` and `cd client && pnpm dev`:
   - Settings › Templates lists the seeded built-ins on a fresh database.
     Delete one, restart the server, confirm it **stays** deleted — that is the
     `introduced` rule, and it is the half of the seeding scheme that is easy to
     break.
   - Add a template pointing at a real repo with a couple of skills linked; it
     appears in the gallery with its kit.
   - Use it: the directory is created on disk, the project row exists with that
     `cwd`, the thread opens with the prompt in the composer, and **nothing has
     been sent** (no session row on the server yet).
   - Send it: the agent clones and installs, and the linked skills are the ones
     the thread spawned with (the composer's read-only tools popover says so).
   - Failure paths: a target that exists and is non-empty is refused readably; a
     parent that does not exist likewise; deleting the project afterwards leaves
     the directory alone (that is `deleteProject`'s existing contract).
5. The user checks the UI — no browser automation or screenshots, per the
   project's own testing rule.

# Mention sources

The composer's `@` menu is a registry of sources. Plain `@path`, `@KEY-12` (a board task) and the
MCP-server / project / MCP-resource rows are the original completer, moved into sources; everything
else is a **typed reference**, `@kind:ref`.

## Grammar

A kind is two or more lowercase letters, a colon, and a ref with no whitespace or `@`. Only the kinds
in `MENTION_KINDS` count, which keeps `C:\x`, `C:/x` and `foo:bar` reading as the paths they always
were. The list is copied in `client/src/lib/mentions/grammar.ts` and `server/src/mentions/grammar.ts`;
`pnpm test:mentions` fails when they drift. The token carries an id, never a title - the chip draws
the title.

| Token | Reads as |
|---|---|
| `@thread:<id>[#turn-N]` | A recap of another thread built from its journal (title, project, first/last user message, last answer, files changed), about 6k characters. |
| `@commit:<sha>` | Message, `--stat`, capped patch. |
| `@branch:<name>`, `@tag:<name>` | Commits ahead of the base and the changed-file list. |
| `@git:changes`, `@git:staged`, `@git:last-turn`, `@git:stash/N` | Working tree, index, what the agent wrote last turn, a stash. |
| `@run:<id>` | A workflow, routine or scheduled run: status, per-step results, final output. |
| `@kb:<id>` | A knowledge-base entry of this project. |
| `@term:<id>`, `@term:last` | The output of a `!` command run in this project (the tail is kept when cut). |
| `@mcp:<serverId>/<uri>` | A resource one of the thread's MCP servers serves, read at send. |
| `@src/a.ts:40-80` | Those lines of a file, numbered. The file still goes as a `resource_link`. |

## Send path

1. The composer posts the text to `POST /api/mentions/context` before the box clears.
2. `server/src/mentions/expand.ts` asks each kind's resolver for blocks and appends one
   `<context>` with a `<mention kind ref>` child per mention. One budget (30k characters) is shared:
   short bodies keep all they have, the rest split what is left, and a cut body names the tool that
   has the rest. At most 20 mentions are read.
3. The tokens a resolver claimed are skipped by the file linker (`mentions.ts`), so a typed
   reference is never also looked up as a path.
4. The bubble folds each block back into a popover on its chip (`lib/mentions/context.ts`). The
   `<tasks>` block of `@KEY-12` is unchanged and still read.

Expansion is client-triggered, so mentions typed into a routine, schedule or workflow prompt are not
expanded. Moving it into `AcpBridge.prompt` would fix that but the transcript would then no longer
hold what the agent was sent. Cross-project thread and commit mentions are allowed: there is one
bearer scope.

A client talking to a server without the `mentionKinds` feature (`compat.ts`) offers no kind sources
and sends plain text.

## Adding a source

Client: a file under `lib/mentions/sources/` exporting `defineKindSource({kind, icon, hint, ...})`
and one line in `lib/mentions/index.ts`. Server: a resolver under `mentions/resolvers/` and one line
in `mentions/index.ts`, plus the kind in both `grammar.ts` files. A resolver never throws for "not
found"; it leaves the ref out of `blocks`.

## `@mcp:`

Fixed resources insert the whole token. A resource **template** inserts the token up to its first
variable and leaves it open. With exactly one variable and a server that declared `completions`,
what is typed is asked of the server (`GET /api/sessions/:id/mcp/:serverId/complete`, MCP
`completion/complete`); otherwise the id is typed by hand and read all the same. A draft has no
thread whose servers could be read, so `@mcp:` is offered only on a started thread.

What the servers linked here offer (probed 2026-10-24): GitHub serves only repository-file
templates (`repo://{owner}/{repo}/contents{/path*}` and refs variants, several variables, with
completion), **not pull requests or issues**; Bugsnag serves `bugsnag://event/{id}` with no
completion; ClickUp and Mawared HR serve fixed resources only. PRs and issues therefore stay behind
the GitHub MCP's tools until that server publishes templates for them.

## Not built

- Symbols (`@src/a.ts#fnName`) - needs a parser or ctags.
- Fetching a mentioned URL at send time.
- `@Codex` as a mention: it is an action, not context, and belongs on the `builtin:agents` door.
- A shell opened in the terminal panel is not mentionable: only `!` runs are journaled.

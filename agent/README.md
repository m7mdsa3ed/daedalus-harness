# Daedalus Agent

The harness's first-party ACP agent runtime: a full agent loop on the Vercel AI
SDK, speaking OpenAI-compatible chat completions to whatever endpoint the
profile names, and the Agent Client Protocol over stdio to the server. It lives
beside `server/` and `client/` as its own package and is seeded into the agent
registry as `daedalus` (`DEFAULT_AGENTS`, seed 14), spawned as
`node agent/dist/index.js` — so `pnpm build` here has to have run (the server's
`pnpm pm2:start` does it via `build:agent`; `DAEDALUS_AGENT_ENTRY` points a
deploy at a different entry).

What it implements, end to end:

- **Sessions**: `session/new`, `session/load` (full replay from its own store),
  `session/list` (paged, cwd-filterable — what the harness's Import dialog
  reads), steering (a prompt mid-turn joins the running turn), `session/cancel`.
- **Store**: `~/.daedalus-agent/` (override `DAEDALUS_AGENT_HOME`) —
  `sessions/<id>.jsonl` holds the model-facing history (`msg` records) and the
  replay stream (`update` records, text coalesced per block); `index.json`
  backs `session/list`.
- **Tools**: `read_file`, `write_file`/`edit_file` (diff content on the tool
  call), `bash` (output streamed through `_meta.terminal_output_delta`),
  `glob`/`grep` (ripgrep when present), `write_todos` (ACP plan),
  `ask_user` (ACP form elicitation, only offered when the client claims it),
  `task` (subagents), plus every MCP server the harness passes at session
  start, named `mcp__<server>__<tool>`.
- **Permissions**: modes `default` / `acceptEdits` / `bypassPermissions` /
  `plan` (plan strips everything that writes); gated tools ask through
  `session/request_permission` with allow/always/reject/always options, and
  the always answers stick per tool for the session.
- **Config options**: `model` (category `model` — the ids come from the
  allowlist the server materializes into `<cwd>/.claude/settings.local.json`,
  which is what makes live model switching work), `effort` (category
  `thought_level`, mapped to the AI SDK's unified `reasoning` option), and an
  `autoCompact` boolean.
- **Subagents**: the ACP Subagent Sessions RFD when the client claims
  `subagents` (spawned / child-addressed updates / state), journal-only
  fallback otherwise.
- **Compaction**: past ~80% of the context window the history is summarized
  with the small model between turns, streamed as compaction updates when the
  client claims `session.compaction`.
- **Commands & skills**: `<cwd>/.claude/commands/*.md` advertised over
  `available_commands_update` and expanded on `/name args`;
  `<cwd>/.claude/skills/*/SKILL.md` listed in the system prompt. The persona
  file (`DAEDALUS_AGENT_PERSONA_FILE`, written by the server) is appended to
  the system prompt.

Env contract (all filled by the server from the profile; empty keys are pruned
and the literal `"null"` means unset): `DAEDALUS_AGENT_API_KEY`, `_BASE_URL`
(the gateway shim URL when one is up), `_MODEL`, `_SMALL_MODEL`, `_EFFORT`,
`_CONTEXT_WINDOW`, `_MAX_OUTPUT_TOKENS`, `_PERSONA_FILE`, `_HOME`.

Dev: `pnpm dev` (tsx watch, for hand-driving over stdio), `pnpm build`,
`pnpm test` (in-process ACP client + scripted mock models; one test spawns the
real binary). Typecheck: `pnpm exec tsc --noEmit`.
